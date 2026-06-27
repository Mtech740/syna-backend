require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');

// ===== YAHOO FINANCE IMPORT (v2) =====
const yahooFinance = require('yahoo-finance2').default;

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: false
});

// ==================== DATABASE SETUP ====================
async function initDB() {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email VARCHAR(255) UNIQUE NOT NULL,
            phone VARCHAR(20),
            username VARCHAR(50) UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            subscription_plan VARCHAR(20) DEFAULT 'free',
            subscription_expiry TIMESTAMP,
            trial_signals_used INTEGER DEFAULT 0,
            free_trades_used INTEGER DEFAULT 0,
            real_account_approved BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_assets (
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            asset_symbol VARCHAR(20),
            PRIMARY KEY (user_id, asset_symbol)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS pending_payments (
            id SERIAL PRIMARY KEY,
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            username VARCHAR(50),
            plan VARCHAR(20),
            amount DECIMAL(10,2),
            reference VARCHAR(100) UNIQUE,
            status VARCHAR(20) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS mt5_accounts (
            id SERIAL PRIMARY KEY,
            user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            api_key TEXT NOT NULL UNIQUE,
            account_id TEXT NOT NULL UNIQUE,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS trade_signals (
            id SERIAL PRIMARY KEY,
            user_id UUID REFERENCES users(id),
            symbol VARCHAR(20),
            action VARCHAR(4),
            confidence DECIMAL(5,2),
            price DECIMAL(15,5),
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);

    console.log('✅ Tables ready');
}
initDB().catch(console.error);

// ==================== AUTH MIDDLEWARE ====================
async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ==================== REGISTER ====================
app.post('/api/auth/register', async (req, res) => {
    const { email, phone, password, username } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    try {
        const hash = await bcrypt.hash(password, 10);
        const finalUsername = username || email.split('@')[0];
        const result = await pool.query(
            `INSERT INTO users(email, phone, password_hash, username)
             VALUES($1, $2, $3, $4)
             RETURNING id, email, phone, username`,
            [email, phone || null, hash, finalUsername]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'Email, username, or phone already exists' });
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== LOGIN ====================
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query(
            `SELECT * FROM users WHERE email = $1`,
            [email]
        );
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                phone: user.phone,
                username: user.username,
                subscription_plan: user.subscription_plan || 'free',
                subscription_expiry: user.subscription_expiry,
                trial_signals_used: user.trial_signals_used || 0,
                free_trades_used: user.free_trades_used || 0,
                real_account_approved: user.real_account_approved || false
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== PROFILE ====================
app.get('/api/user/profile', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, email, phone, username, subscription_plan, subscription_expiry, trial_signals_used, free_trades_used, real_account_approved, created_at 
             FROM users WHERE id = $1`,
            [req.userId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Profile error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== TRIAL REMAINING ====================
app.get('/api/user/trial-remaining', authMiddleware, async (req, res) => {
    try {
        const user = await pool.query(
            `SELECT subscription_plan, free_trades_used FROM users WHERE id = $1`,
            [req.userId]
        );
        const plan = user.rows[0]?.subscription_plan || 'free';
        const freeTradesUsed = parseInt(user.rows[0]?.free_trades_used) || 0;
        
        if (plan === 'free') {
            return res.json({ 
                remaining: '♾️',
                total_free_trades: 'Unlimited',
                used: freeTradesUsed,
                is_free_trial: true
            });
        }
        
        res.json({ 
            remaining: '♾️',
            total_free_trades: 'Unlimited',
            used: freeTradesUsed,
            is_free_trial: false
        });
    } catch (err) {
        console.error('Trial remaining error:', err);
        res.json({ remaining: '♾️', total_free_trades: 'Unlimited', used: 0, is_free_trial: true });
    }
});

// ==================== SUBSCRIPTION REQUEST ====================
app.post('/api/subscription/request', authMiddleware, async (req, res) => {
    const { plan } = req.body;
    
    if (!['free', 'basic', 'premium'].includes(plan)) {
        return res.status(400).json({ error: 'Invalid plan' });
    }

    if (plan === 'free') {
        await pool.query(
            `UPDATE users SET subscription_plan = 'free', free_trades_used = 0 WHERE id = $1`,
            [req.userId]
        );
        return res.json({
            success: true,
            message: 'Free trial activated! You have unlimited demo trades.',
            is_free_trial: true
        });
    }

    const userResult = await pool.query(
        `SELECT username FROM users WHERE id = $1`,
        [req.userId]
    );
    const username = userResult.rows[0].username;
    const reference = `syna@${username}`;
    const amount = plan === 'basic' ? 5 : 15;

    const existing = await pool.query(
        `SELECT id FROM pending_payments WHERE user_id = $1 AND status = $2`,
        [req.userId, 'pending']
    );
    if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'You already have a pending payment. Wait for admin approval.' });
    }

    await pool.query(
        `INSERT INTO pending_payments (user_id, username, plan, amount, reference)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.userId, username, plan, amount, reference]
    );

    res.json({
        success: true,
        message: `Payment request created for ${plan} plan. Send payment and wait for admin approval.`,
        reference: reference,
        mtn_code: '90571160',
        amount: amount,
        is_free_trial: false
    });
});

// ==================== ADMIN APPROVE PAYMENT ====================
app.post('/api/admin/approve-payment', async (req, res) => {
    const { secret, reference } = req.body;
    if (secret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        const payment = await pool.query(
            `SELECT user_id, plan FROM pending_payments WHERE reference = $1 AND status = $2`,
            [reference, 'pending']
        );
        if (payment.rows.length === 0) {
            return res.status(404).json({ error: 'No pending payment found with that reference' });
        }

        const { user_id, plan } = payment.rows[0];
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + 30);

        await pool.query(
            `UPDATE users SET subscription_plan = $1, subscription_expiry = $2 WHERE id = $3`,
            [plan, expiry, user_id]
        );
        await pool.query(
            `UPDATE pending_payments SET status = $1 WHERE reference = $2`,
            ['approved', reference]
        );

        res.json({
            success: true,
            message: `User activated on ${plan} plan for 30 days`
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== ADMIN APPROVE REAL ACCOUNT ====================
app.post('/api/admin/approve-real-account', async (req, res) => {
    const { secret, username } = req.body;
    if (secret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        const result = await pool.query(
            `UPDATE users SET real_account_approved = true WHERE username = $1 RETURNING id, username`,
            [username]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({
            success: true,
            message: `Real account approved for ${username}`
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== ADMIN PENDING ====================
app.get('/api/admin/pending-payments', async (req, res) => {
    const { secret } = req.query;
    if (secret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const payments = await pool.query(
        `SELECT id, username, plan, amount, reference, status, created_at 
         FROM pending_payments 
         WHERE status = $1 
         ORDER BY created_at DESC`,
        ['pending']
    );
    res.json(payments.rows);
});

// ==================== ASSETS ====================
const ALL_ASSETS = ['XAUUSD', 'US30', 'NAS100', 'EURUSD', 'GBPUSD', 'BTCUSD'];

app.get('/api/assets/allowed', authMiddleware, async (req, res) => {
    try {
        const user = await pool.query(
            `SELECT subscription_plan FROM users WHERE id = $1`,
            [req.userId]
        );
        const plan = user.rows[0]?.subscription_plan || 'free';
        let allowedAssets = ALL_ASSETS;
        if (plan === 'basic') allowedAssets = ['BTCUSD'];
        res.json({ assets: allowedAssets });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/user/assets', authMiddleware, async (req, res) => {
    const { assets } = req.body;
    if (!Array.isArray(assets)) return res.status(400).json({ error: 'Assets must be an array' });
    try {
        await pool.query(
            `DELETE FROM user_assets WHERE user_id = $1`,
            [req.userId]
        );
        for (const asset of assets) {
            await pool.query(
                `INSERT INTO user_assets(user_id, asset_symbol) VALUES($1, $2)`,
                [req.userId, asset]
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/user/assets', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT asset_symbol FROM user_assets WHERE user_id = $1`,
            [req.userId]
        );
        res.json({ assets: result.rows.map(r => r.asset_symbol) });
    } catch (err) {
        res.json({ assets: [] });
    }
});

// ==================== MT5 REGISTRATION ====================
app.post('/api/mt5/register', authMiddleware, async (req, res) => {
    try {
        const user = await pool.query(
            `SELECT subscription_plan, real_account_approved FROM users WHERE id = $1`,
            [req.userId]
        );
        const plan = user.rows[0]?.subscription_plan || 'free';
        
        const apiKey = crypto.randomBytes(32).toString('hex');
        const accountId = `MT5_${req.userId}_${Date.now()}`;
        await pool.query(`
            INSERT INTO mt5_accounts (user_id, api_key, account_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id) DO UPDATE
            SET api_key = EXCLUDED.api_key, account_id = EXCLUDED.account_id
        `, [req.userId, apiKey, accountId]);
        
        const isFreeTrial = plan === 'free';
        
        res.json({
            success: true,
            api_key: apiKey,
            account_id: accountId,
            websocket_url: `ws://localhost:${PORT}`,
            plan: plan,
            is_demo_only: isFreeTrial,
            real_account_approved: user.rows[0]?.real_account_approved || false,
            message: isFreeTrial ? 'Free trial – demo account only (unlimited trades)' : 'Full access'
        });
    } catch (err) {
        console.error('MT5 registration error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== SYNA V4 AI ENGINE ====================
const symbolMap = {
    'BTCUSD': 'BTC-USD',
    'XAUUSD': 'GC=F',
    'US30': 'YM=F',
    'NAS100': 'NQ=F',
    'EURUSD': 'EURUSD=X',
    'GBPUSD': 'GBPUSD=X'
};

function calculateEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

function calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        const diff = prices[i] - prices[i-1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateATR(high, low, close, period = 14) {
    const tr = [];
    for (let i = 1; i < high.length; i++) {
        const hl = high[i] - low[i];
        const hc = Math.abs(high[i] - close[i - 1]);
        const lc = Math.abs(low[i] - close[i - 1]);
        tr.push(Math.max(hl, hc, lc));
    }
    if (tr.length < period) return 0;
    let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < tr.length; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
    }
    return atr;
}

async function getLiveMarketData(symbol) {
    const yahooSymbol = symbolMap[symbol];
    if (!yahooSymbol) throw new Error(`Unknown symbol: ${symbol}`);
    
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    
    try {
        const result = await yahooFinance.historical(yahooSymbol, {
            period1: startDate,
            period2: endDate,
            interval: '1h'
        });
        
        if (!result || result.length < 50) {
            console.log(`⚠️ Insufficient data for ${symbol}, using mock data`);
            throw new Error('Insufficient data');
        }
        
        const closePrices = result.map(c => c.close);
        const highPrices = result.map(c => c.high);
        const lowPrices = result.map(c => c.low);
        const currentPrice = closePrices[closePrices.length - 1];
        const ema50 = calculateEMA(closePrices, 50);
        const rsi = calculateRSI(closePrices, 14);
        const atr = calculateATR(highPrices, lowPrices, closePrices, 14);
        return { currentPrice, ema50, rsi, atr };
    } catch (error) {
        console.log(`⚠️ Yahoo Finance error for ${symbol}: ${error.message}`);
        console.log(`📊 Using mock data for ${symbol}`);
        return {
            currentPrice: 1.31874,
            ema50: 1.31500,
            rsi: 55,
            atr: 0.005
        };
    }
}

function generateSignal(price, ema, rsi, atr) {
    const trendUp = price > ema;
    if (trendUp && rsi < 70) {
        return { action: 'BUY', confidence: 0.85, sl: atr * 1.5, tp: atr * 3 };
    } else if (!trendUp && rsi > 30) {
        return { action: 'SELL', confidence: 0.80, sl: atr * 1.5, tp: atr * 3 };
    } else {
        return { action: 'HOLD', confidence: 0 };
    }
}

// ==================== MT5 SIGNAL ENDPOINT ====================
app.get('/api/mt5/signal', async (req, res) => {
    const { api_key, symbol } = req.query;
    if (!api_key || !symbol) return res.status(400).json({ error: 'Missing api_key or symbol' });
    
    try {
        const mt5Acc = await pool.query(
            `SELECT user_id FROM mt5_accounts WHERE api_key = $1`,
            [api_key]
        );
        if (mt5Acc.rows.length === 0) return res.status(401).json({ error: 'Invalid API key' });
        
        const userId = mt5Acc.rows[0].user_id;
        const user = await pool.query(
            `SELECT subscription_plan, free_trades_used, real_account_approved FROM users WHERE id = $1`,
            [userId]
        );
        const plan = user.rows[0]?.subscription_plan || 'free';
        const realAccountApproved = user.rows[0]?.real_account_approved || false;
        
        if (plan === 'basic' && symbol !== 'BTCUSD') {
            return res.json({ 
                action: 'HOLD', 
                reason: 'Basic plan only allows BTCUSD',
                free_trades_remaining: '♾️'
            });
        }
        
        const { currentPrice, ema50, rsi, atr } = await getLiveMarketData(symbol);
        const signal = generateSignal(currentPrice, ema50, rsi, atr);
        
        if (signal.action !== 'HOLD') {
            await pool.query(
                `INSERT INTO trade_signals (user_id, symbol, action, confidence, price)
                 VALUES ($1, $2, $3, $4, $5)`,
                [userId, symbol, signal.action, signal.confidence, currentPrice]
            );
            
            res.json({
                action: signal.action,
                symbol: symbol,
                price: currentPrice,
                lot: 0.01,
                sl_distance: signal.sl,
                tp_distance: signal.tp,
                confidence: signal.confidence,
                timestamp: new Date().toISOString(),
                free_trades_remaining: '♾️',
                plan: plan,
                real_account_approved: realAccountApproved,
                is_demo_only: plan === 'free'
            });
        } else {
            res.json({
                action: 'HOLD',
                symbol: symbol,
                price: currentPrice,
                timestamp: new Date().toISOString(),
                free_trades_remaining: '♾️',
                plan: plan,
                real_account_approved: realAccountApproved,
                is_demo_only: plan === 'free'
            });
        }
    } catch (err) {
        console.error('Signal error:', err);
        res.status(500).json({ error: 'Failed to generate signal', details: err.message });
    }
});

// ==================== HEALTH ====================
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ==================== CATCH-ALL ====================
app.get('*', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SYNA V4 AI Engine running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT} to use SYNA`);
});