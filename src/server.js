import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'municipal-perf-mgmt-secret-key';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const dbPath = join(__dirname, 'municipal_performance.db');
const db = new sqlite3.Database(dbPath);

const initializeDatabase = () => {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      department TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    
    `CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      head_user_id INTEGER,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (head_user_id) REFERENCES users (id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS kpis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      department_id INTEGER NOT NULL,
      measurement_unit TEXT,
      target_value REAL,
      threshold_warning REAL,
      threshold_critical REAL,
      calculation_method TEXT,
      frequency TEXT DEFAULT 'monthly',
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments (id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS performance_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kpi_id INTEGER NOT NULL,
      value REAL NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      submitted_by INTEGER NOT NULL,
      comments TEXT,
      verified INTEGER DEFAULT 0,
      verified_by INTEGER,
      verified_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (kpi_id) REFERENCES kpis (id),
      FOREIGN KEY (submitted_by) REFERENCES users (id),
      FOREIGN KEY (verified_by) REFERENCES users (id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS compliance_standards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      regulation_reference TEXT,
      department_id INTEGER,
      compliance_frequency TEXT DEFAULT 'quarterly',
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments (id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS compliance_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      standard_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      assessment_date DATE NOT NULL,
      assessor_id INTEGER NOT NULL,
      findings TEXT,
      action_items TEXT,
      due_date DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (standard_id) REFERENCES compliance_standards (id),
      FOREIGN KEY (assessor_id) REFERENCES users (id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      read_status INTEGER DEFAULT 0,
      priority TEXT DEFAULT 'normal',
      related_entity_type TEXT,
      related_entity_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS audit_trail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      old_values TEXT,
      new_values TEXT,
      ip_address TEXT,
      user_agent TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      parameters TEXT,
      generated_by INTEGER NOT NULL,
      file_path TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (generated_by) REFERENCES users (id)
    )`
  ];

  tables.forEach(sql => {
    db.run(sql, (err) => {
      if (err) {
        console.error('Error creating table:', err.message);
      }
    });
  });

  const defaultDepartments = [
    'Administration', 'Finance', 'Human Resources', 'Technical Services', 
    'Community Services', 'Planning and Development', 'Public Safety'
  ];

  defaultDepartments.forEach(dept => {
    db.run(
      'INSERT OR IGNORE INTO departments (name, description) VALUES (?, ?)',
      [dept, `${dept} Department`]
    );
  });
};

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

const logAuditTrail = (userId, action, entityType, entityId, oldValues = null, newValues = null, req) => {
  const auditData = {
    user_id: userId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    old_values: oldValues ? JSON.stringify(oldValues) : null,
    new_values: newValues ? JSON.stringify(newValues) : null,
    ip_address: req.ip,
    user_agent: req.get('User-Agent')
  };

  db.run(
    `INSERT INTO audit_trail (user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    Object.values(auditData)
  );
};

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'Municipal Performance Management System',
    version: '1.0.0'
  });
});

app.get('/api/dashboard/overview', authenticateToken, (req, res) => {
  const overviewQueries = {
    totalKPIs: 'SELECT COUNT(*) as count FROM kpis WHERE active = 1',
    totalDepartments: 'SELECT COUNT(*) as count FROM departments WHERE active = 1',
    complianceRate: `SELECT 
      ROUND(AVG(CASE WHEN status = 'compliant' THEN 100 ELSE 0 END), 2) as rate
      FROM compliance_status cs
      INNER JOIN compliance_standards std ON cs.standard_id = std.id
      WHERE cs.assessment_date >= date('now', '-1 month')`,
    recentPerformance: `SELECT 
      k.name, pd.value, pd.period_end, d.name as department
      FROM performance_data pd
      INNER JOIN kpis k ON pd.kpi_id = k.id
      INNER JOIN departments d ON k.department_id = d.id
      ORDER BY pd.created_at DESC LIMIT 10`,
    criticalAlerts: `SELECT COUNT(*) as count
      FROM performance_data pd
      INNER JOIN kpis k ON pd.kpi_id = k.id
      WHERE pd.value < k.threshold_critical
      AND pd.period_end >= date('now', '-1 month')`
  };

  let results = {};
  let completedQueries = 0;
  const totalQueries = Object.keys(overviewQueries).length;

  Object.entries(overviewQueries).forEach(([key, query]) => {
    db.all(query, [], (err, rows) => {
      if (err) {
        console.error(`Error executing ${key} query:`, err);
        results[key] = null;
      } else {
        results[key] = key === 'recentPerformance' ? rows : rows[0];
      }
      
      completedQueries++;
      if (completedQueries === totalQueries) {
        res.json({
          totalKPIs: results.totalKPIs?.count || 0,
          totalDepartments: results.totalDepartments?.count || 0,
          complianceRate: results.complianceRate?.rate || 0,
          criticalAlerts: results.criticalAlerts?.count || 0,
          recentPerformance: results.recentPerformance || []
        });
      }
    });
  });
});

app.post('/api/kpis', authenticateToken, (req, res) => {
  const {
    name, description, department_id, measurement_unit,
    target_value, threshold_warning, threshold_critical,
    calculation_method, frequency
  } = req.body;

  if (!name || !department_id) {
    return res.status(400).json({ error: 'Name and department_id are required' });
  }

  const sql = `INSERT INTO kpis 
    (name, description, department_id, measurement_unit, target_value, 
     threshold_warning, threshold_critical, calculation_method, frequency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const params = [
    name, description, department_id, measurement_unit,
    target_value, threshold_warning, threshold_critical,
    calculation_method, frequency
  ];

  db.run(sql, params, function(err) {
    if (err) {
      console.error('Error creating KPI:', err);
      return res.status(500).json({ error: 'Failed to create KPI' });
    }

    logAuditTrail(req.user.userId, 'CREATE', 'kpi', this.lastID, null, req.body, req);
    
    res.status(201).json({
      message: 'KPI created successfully',
      kpi_id: this.lastID
    });
  });
});

app.put('/api/kpis/:id', authenticateToken, (req, res) => {
  const kpiId = req.params.id;
  const updates = req.body;

  db.get('SELECT * FROM kpis WHERE id = ?', [kpiId], (err, oldData) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    if (!oldData) {
      return res.status(404).json({ error: 'KPI not found' });
    }

    const allowedFields = [
      'name', 'description', 'measurement_unit', 'target_value',
      'threshold_warning', 'threshold_critical', 'calculation_method', 'frequency'
    ];

    const setClause = [];
    const params = [];

    Object.entries(updates).forEach(([key, value]) => {
      if (allowedFields.includes(key)) {
        setClause.push(`${key} = ?`);
        params.push(value);
      }
    });

    if (setClause.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    setClause.push('updated_at = CURRENT_TIMESTAMP');
    params.push(kpiId);

    const sql = `UPDATE kpis SET ${setClause.join(', ')} WHERE id = ?`;

    db.run(sql, params, function(err) {
      if (err) {
        console.error('Error updating KPI:', err);
        return res.status(500).json({ error: 'Failed to update KPI' });
      }

      logAuditTrail(req.user.userId, 'UPDATE', 'kpi', kpiId, oldData, updates, req);

      res.json({ message: 'KPI updated successfully' });
    });
  });
});

app.get('/api/kpis/department/:dept', authenticateToken, (req, res) => {
  const departmentId = req.params.dept;

  const sql = `SELECT 
    k.*, d.name as department_name,
    COUNT(pd.id) as data_points,
    MAX(pd.period_end) as last_updated
    FROM kpis k
    LEFT JOIN departments d ON k.department_id = d.id
    LEFT JOIN performance_data pd ON k.id = pd.kpi_id
    WHERE k.department_id = ? AND k.active = 1
    GROUP BY k.id
    ORDER BY k.name`;

  db.all(sql, [departmentId], (err, rows) => {
    if (err) {
      console.error('Error fetching KPIs:', err);
      return res.status(500).json({ error: 'Failed to fetch KPIs' });
    }

    res.json(rows);
  });
});

app.post('/api/data/collect', authenticateToken, (req, res) => {
  const { kpi_id, value, period_start, period_end, comments } = req.body;

  if (!kpi_id || value === undefined || !period_start || !period_end) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const sql = `INSERT INTO performance_data 
    (kpi_id, value, period_start, period_end, submitted_by, comments)
    VALUES (?, ?, ?, ?, ?, ?)`;

  const params = [kpi_id, value, period_start, period_end, req.user.userId, comments];

  db.run(sql, params, function(err) {
    if (err) {
      console.error('Error collecting performance data:', err);
      return res.status(500).json({ error: 'Failed to collect performance data' });
    }

    db.get(
      'SELECT threshold_warning, threshold_critical FROM kpis WHERE id = ?',
      [kpi_id],
      (