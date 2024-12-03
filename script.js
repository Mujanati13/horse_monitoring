const express = require('express');
const mysql = require('mysql2/promise');
const mysql2 = require('mysql2');
const cors = require('cors');
require('dotenv').config();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const http = require('http');

const app = express();
app.use(cors());

// Only apply JSON middleware to routes that aren't /video-frame
app.use((req, res, next) => {
    if (req.path === '/video-frame') {
        next();
    } else {
        express.json()(req, res, next);
    }
});

// Create HTTP server from Express app
const server = http.createServer(app);

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ server });

// Database connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'horse_monitoring',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Handle WebSocket connections
wss.on('connection', (ws) => {
    console.log('Client connected');

    // Handle incoming messages
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received:', data);
        } catch (e) {
            console.log('Received binary data');
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });

    // Send initial connection confirmation
    ws.send(JSON.stringify({ type: 'connection', status: 'connected' }));
});

// Endpoint to receive frames from Python - using raw parser only for this route
app.post('/video-frame', express.raw({ type: 'image/jpeg', limit: '10mb' }), (req, res) => {
    try {
        // Broadcast the frame to all WebSocket clients
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(req.body, { binary: true });
            }
        });
        console.log("Received frame from Python");
        res.sendStatus(200);
    } catch (error) {
        console.error('Error processing video frame:', error);
        res.sendStatus(500);
    }
});

// Heart beat endpoint to check if server is alive
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Endpoint to check database connection
app.get('/check-connection', async (req, res) => {
    try {
        const connection = await pool.getConnection();
        await connection.ping();
        connection.release();
        res.status(200).json({ message: 'Database connection successful' });
    } catch (error) {
        console.error('Database connection failed:', error);
        res.status(500).json({ message: 'Database connection failed', error: error.message });
    }
});

// 1. Activity Detection Endpoint
app.post('/api/detections', async (req, res) => {
    try {
        const { horse_id, predictions } = req.body;
        const connection = await pool.getConnection();

        try {
            await connection.beginTransaction();

            // Insert each detection
            for (const prediction of predictions) {
                await connection.query(
                    `INSERT INTO activities (
                        horse_id, activity_type, confidence, 
                        x_position, y_position, width, height, 
                        detection_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        horse_id,
                        prediction.class,
                        prediction.confidence,
                        prediction.x,
                        prediction.y,
                        prediction.width,
                        prediction.height,
                        prediction.detection_id
                    ]
                );
            }

            // Update daily summary
            const today = new Date().toISOString().split('T')[0];

            // Get today's counts
            const [counts] = await connection.query(
                `SELECT 
                    COUNT(CASE WHEN activity_type = 'laying' THEN 1 END) as laying_count,
                    COUNT(CASE WHEN activity_type = 'standing' THEN 1 END) as standing_count
                FROM activities 
                WHERE horse_id = ? 
                AND DATE(timestamp) = ?`,
                [horse_id, today]
            );

            const layingCount = counts[0].laying_count;
            const standingCount = counts[0].standing_count;
            const totalCount = layingCount + standingCount;
            const layingRatio = totalCount > 0 ? layingCount / totalCount : 0;

            // Determine alert status
            let alertStatus = 'Normal activity';
            if (layingRatio > 0.6) alertStatus = 'Excessive laying';
            else if (layingRatio < 0.2) alertStatus = 'Minimal rest';

            // Upsert daily summary
            await connection.query(
                `INSERT INTO daily_summaries 
                    (horse_id, date, laying_count, standing_count, laying_ratio, total_detections, alert_status)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    laying_count = ?,
                    standing_count = ?,
                    laying_ratio = ?,
                    total_detections = ?,
                    alert_status = ?`,
                [
                    horse_id, today, layingCount, standingCount, layingRatio,
                    totalCount, alertStatus, layingCount, standingCount,
                    layingRatio, totalCount, alertStatus
                ]
            );

            await connection.commit();
            res.json({ success: true, message: 'Detections recorded successfully' });
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error recording detections:', error);
        res.status(500).json({ error: 'Failed to record detections' });
    }
});

// 2. Get Activity Summary
app.get('/api/summary/:horseId', async (req, res) => {
    try {
        const { horseId } = req.params;
        const [summary] = await pool.query(
            `SELECT * FROM daily_summaries 
            WHERE horse_id = ? 
            AND date = CURDATE()`,
            [horseId]
        );

        res.json(summary[0] || {
            laying_count: 0,
            standing_count: 0,
            laying_ratio: 0,
            alert_status: 'No data'
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch summary' });
    }
});

// 3. Get Activity Timeline
app.get('/api/timeline/:horseId', async (req, res) => {
    try {
        const { horseId } = req.params;
        const { timeframe } = req.query; // 'hourly', 'daily', or 'monthly'

        let query;
        switch (timeframe) {
            case 'hourly':
                query = `
                    SELECT 
                        HOUR(timestamp) as hour,
                        COUNT(CASE WHEN activity_type = 'laying' THEN 1 END) as laying_count,
                        COUNT(CASE WHEN activity_type = 'standing' THEN 1 END) as standing_count
                    FROM activities
                    WHERE horse_id = ? 
                    AND DATE(timestamp) = CURDATE()
                    GROUP BY HOUR(timestamp)
                    ORDER BY hour`;
                break;

            case 'daily':
                query = `
                    SELECT 
                        DATE_FORMAT(date, '%a') as day,
                        laying_count,
                        standing_count
                    FROM daily_summaries
                    WHERE horse_id = ?
                    AND date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
                    ORDER BY date`;
                break;

            case 'monthly':
                query = `
                    SELECT 
                        DATE_FORMAT(date, '%b') as month,
                        SUM(laying_count) as laying_count,
                        SUM(standing_count) as standing_count
                    FROM daily_summaries
                    WHERE horse_id = ?
                    AND date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
                    GROUP BY YEAR(date), MONTH(date)
                    ORDER BY date`;
                break;

            default:
                throw new Error('Invalid timeframe');
        }

        const [data] = await pool.query(query, [horseId]);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch timeline data' });
    }
});

// 4. Get Health Summary
app.get('/api/health/:horseId', async (req, res) => {
    try {
        const { horseId } = req.params;

        // Get health metrics
        const [metrics] = await pool.query(
            `SELECT * FROM health_metrics 
            WHERE horse_id = ? 
            AND date = CURDATE()`,
            [horseId]
        );

        // Get active alerts
        const [alerts] = await pool.query(
            `SELECT * FROM health_alerts 
            WHERE horse_id = ? 
            AND is_resolved = FALSE 
            ORDER BY created_at DESC 
            LIMIT 5`,
            [horseId]
        );

        res.json({
            sleepQuality: {
                score: metrics[0]?.sleep_quality_score || 0,
                trend: 'stable', // You would calculate this based on historical data
                recommendation: 'Maintain current routine'
            },
            activityLevel: {
                score: metrics[0]?.activity_level_score || 0,
                trend: 'increasing',
                recommendation: 'Good activity level'
            },
            restingPeriods: {
                daily: metrics[0]?.daily_rest_periods || 0,
                avgDuration: `${metrics[0]?.avg_rest_duration || 0} minutes`
            },
            healthIndicators: {
                posture: metrics[0]?.posture_status || 'Unknown',
                mobility: metrics[0]?.mobility_status || 'Unknown',
                restlessness: metrics[0]?.restlessness_level || 'Unknown',
                lastVetVisit: metrics[0]?.last_vet_visit
            },
            alerts: alerts.map(alert => ({
                type: alert.alert_type,
                message: alert.message,
                date: alert.alert_date
            }))
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch health summary' });
    }
});


// Secret key for JWT
const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

// Register endpoint
app.post('/register', async (req, res) => {
    const { username, password } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(password, 10);  // Hash the password

        const connection = await pool.getConnection();
        await connection.query(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            [username, hashedPassword]
        );
        connection.release();

        res.status(201).json({ message: 'User registered successfully' });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ message: 'Registration failed', error });
    }
});

// Login endpoint
app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const connection = await pool.getConnection();
        const [rows] = await connection.query('SELECT * FROM users WHERE username = ?', [username]);
        connection.release();

        if (rows.length === 0) {
            return res.status(401).json({ message: 'Invalid username or password' });
        }

        const user = rows[0];
        const isPasswordValid = await bcrypt.compare(password, user.password);

        if (!isPasswordValid) {
            return res.status(401).json({ message: 'Invalid username or password' });
        }

        // Generate a JWT token
        const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });

        res.status(200).json({ message: 'Login successful', token });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Login failed', error });
    }
});

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];

    if (!token) return res.status(401).json({ message: 'Access token missing' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Invalid token' });
        req.user = user;
        next();
    });
}

// Example of a protected route
app.get('/protected', authenticateToken, (req, res) => {
    res.status(200).json({ message: 'This is a protected route', user: req.user });
});

// Get horse profile with medical history
app.get('/horses/:id', async (req, res, next) => {
    try {
        const connection = await pool.getConnection();

        try {
            // Get horse details
            const [horseRows] = await connection.query(
                'SELECT * FROM horses_infos WHERE id = ?',
                [req.params.id]
            );

            if (horseRows.length === 0) {
                return res.status(404).json({ error: 'Horse not found' });
            }

            // Get medical history
            const [medicalRows] = await connection.query(
                'SELECT * FROM medical_treatments WHERE horse_id = ? ORDER BY treatment_date DESC',
                [req.params.id]
            );

            const horse = {
                ...horseRows[0],
                medicalHistory: medicalRows
            };

            res.json(horse);
        } finally {
            connection.release();
        }
    } catch (err) {
        next(err);
    }
});

// Update horse profile
app.put('/horses/:id', async (req, res, next) => {
    try {
        const {
            name, breed, age, color, gender, weight, height,
            microchip_number, owner
        } = req.body;

        const connection = await pool.getConnection();

        try {
            await connection.query(
                `UPDATE horses_infos SET 
            name = ?, breed = ?, age = ?, color = ?, 
            gender = ?, weight = ?, height = ?,
            microchip_number = ?, owner = ?
          WHERE id = ?`,
                [name, breed, age, color, gender, weight, height,
                    microchip_number, owner, req.params.id]
            );

            res.json({ message: 'Horse profile updated successfully' });
        } finally {
            connection.release();
        }
    } catch (err) {
        next(err);
    }
});

// Add new medical treatment
app.post('/horses/:id/treatments', async (req, res, next) => {
    try {
        const {
            type, name, treatment_date, next_due_date,
            veterinarian, notes
        } = req.body;

        console.log(type, name, treatment_date, next_due_date,
            veterinarian, notes);


        const connection = await pool.getConnection();

        try {
            const treatmentId = Math.random() * 1000;

            await connection.query(
                `INSERT INTO medical_treatments 
            (id, horse_id, type, name, treatment_date, 
             next_due_date, veterinarian, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [treatmentId, req.params.id, type, name,
                    treatment_date, next_due_date, veterinarian, notes]
            );

            res.status(201).json({
                message: 'Treatment added successfully',
                treatmentId
            });
        } finally {
            connection.release();
        }
    } catch (err) {
        next(err);
    }
});

// Get all treatments for a horse
app.get('/horses/:id/treatments', async (req, res, next) => {
    try {
        const connection = await pool.getConnection();

        try {
            const [rows] = await connection.query(
                'SELECT * FROM medical_treatments WHERE horse_id = ? ORDER BY treatment_date DESC',
                [req.params.id]
            );

            res.json(rows);
        } finally {
            connection.release();
        }
    } catch (err) {
        next(err);
    }
});

// Delete a treatment
app.delete('/horses/:horseId/treatments/:treatmentId', async (req, res, next) => {
    try {
        const connection = await pool.getConnection();

        try {
            await connection.query(
                'DELETE FROM medical_treatments WHERE id = ? AND horse_id = ?',
                [req.params.treatmentId, req.params.horseId]
            );

            res.json({ message: 'Treatment deleted successfully' });
        } finally {
            connection.release();
        }
    } catch (err) {
        next(err);
    }
});


app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        error: 'Internal Server Error',
        message: err.message 
    });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server is running on ws://localhost:${PORT}`);
});