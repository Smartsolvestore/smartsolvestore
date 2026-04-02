require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==========================================
// Supabase Setup
// ==========================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ==========================================
// JWT Helpers
// ==========================================
const JWT_SECRET = process.env.JWT_SECRET;
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  const token = auth.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });
  req.user = decoded;
  next();
}
function authenticateAdmin(req, res, next) {
  authenticate(req, res, () => {
    if (req.user.role !== 'admin' && req.user.phone !== process.env.ADMIN_PHONE) {
      return res.status(403).json({ error: 'Admin required' });
    }
    next();
  });
}

// ==========================================
// Helper Functions
// ==========================================
function normalizePhone(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('91') && cleaned.length === 12) cleaned = cleaned.slice(2);
  if (!/^[6-9]\d{9}$/.test(cleaned)) return null;
  return '+91' + cleaned;
}
async function logAttempt(code, phone, ip, success, msg) {
  try {
    await supabase.from('verification_attempts').insert({
      code_attempted: code,
      phone_attempted: phone,
      ip_address: ip,
      success,
      error_message: msg
    });
  } catch (e) { console.error('Log failed', e); }
}
function organizePremiumContent(raw) {
  const org = { guides: [], videos: [], tips: {}, fixes: [] };
  raw?.forEach(item => {
    switch (item.content_type) {
      case 'guide': org.guides.push({ id: item.id, title: item.title, steps: item.content.steps || [] }); break;
      case 'video': org.videos.push({ id: item.id, title: item.title, url: item.content.url, duration: item.content.duration }); break;
      case 'tip':
        const cat = item.content.category || 'general';
        if (!org.tips[cat]) org.tips[cat] = [];
        org.tips[cat].push(item.content.text);
        break;
      case 'fix': org.fixes.push({ id: item.id, problem: item.title, causes: item.content.causes || [], solutions: item.content.solutions || [] }); break;
    }
  });
  return org;
}

// ==========================================
// Rate Limiter (in‑memory)
// ==========================================
const verificationAttempts = new Map();
function checkRateLimit(key, limit = 5, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const record = verificationAttempts.get(key);
  if (!record) {
    verificationAttempts.set(key, { count: 1, firstAttempt: now });
    return true;
  }
  if (now - record.firstAttempt > windowMs) {
    verificationAttempts.set(key, { count: 1, firstAttempt: now });
    return true;
  }
  if (record.count >= limit) return false;
  record.count++;
  verificationAttempts.set(key, record);
  return true;
}

// ==========================================
// Products API
// ==========================================
app.get('/api/products', async (req, res) => {
  const { data, error } = await supabase.from('products').select('*').eq('active', true).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ products: data });
});

app.get('/api/products/:id', async (req, res) => {
  const { data, error } = await supabase.from('products').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Product not found' });
  res.json(data);
});

// ==========================================
// Order & Payment (UPI manual + COD)
// ==========================================
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, items, customerInfo, paymentMethod } = req.body;
    if (!amount || amount < 100) return res.status(400).json({ error: 'Invalid amount' });

    if (paymentMethod === 'cod') {
      const { data: minSetting } = await supabase.from('site_settings').select('value').eq('key', 'cod_min_amount').single();
      const minAmount = minSetting?.value ? parseInt(minSetting.value) : 0;
      if (minAmount > 0 && amount/100 < minAmount) {
        return res.status(400).json({ error: `COD available only for orders above ₹${minAmount}` });
      }
      const orderId = `COD_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const { data, error } = await supabase.from('orders').insert({
        razorpay_order_id: orderId,
        amount: amount / 100,
        currency: 'INR',
        status: 'cod_pending',
        payment_method: 'cod',
        customer_name: customerInfo?.name,
        customer_phone: customerInfo?.phone,
        customer_email: customerInfo?.email,
        items: items,
        shipping_address: customerInfo?.address,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).select().single();
      if (error) throw error;
      return res.json({ status: 'cod_created', order_id: orderId, amount: amount });
    }

    if (paymentMethod === 'upi') {
      const orderId = `UPI_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const upiId = process.env.UPI_ID || '9123869646@fam';
      const payeeName = process.env.PAYEE_NAME || 'SmartSolve';
      const { data, error } = await supabase.from('orders').insert({
        razorpay_order_id: orderId,
        amount: amount / 100,
        currency: 'INR',
        status: 'upi_pending',
        payment_method: 'upi',
        customer_name: customerInfo?.name,
        customer_phone: customerInfo?.phone,
        customer_email: customerInfo?.email,
        items: items,
        shipping_address: customerInfo?.address,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).select().single();
      if (error) throw error;
      const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${amount/100}&cu=INR&tn=${encodeURIComponent('Order ' + orderId)}`;
      return res.json({ status: 'upi_created', order_id: orderId, amount: amount, upi_link: upiLink });
    }

    return res.status(400).json({ error: 'Invalid payment method' });
  } catch (error) {
    console.error('Order creation failed:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// ==========================================
// Verification API
// ==========================================
app.post('/api/verify-code', async (req, res) => {
  const { code, phone, name, email } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const rateKey = `${ip}:${phone}`;
  if (!checkRateLimit(rateKey)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  if (!code || !phone || !name) return res.status(400).json({ error: 'Missing fields' });
  const normCode = code.trim().toUpperCase();
  const normPhone = normalizePhone(phone);
  if (!normPhone) return res.status(400).json({ error: 'Invalid phone' });
  const codePattern = /^SS\d{6}-([A-Z]{3})-\d{3}-[A-Z0-9]{3}$/;
  if (!codePattern.test(normCode)) {
    await logAttempt(normCode, phone, ip, false, 'Invalid format');
    return res.status(400).json({ error: 'Invalid format' });
  }
  try {
    const { data: codeRecord, error: codeErr } = await supabase.from('verification_codes').select('*, products(*)').eq('code', normCode).single();
    if (codeErr || !codeRecord) {
      await logAttempt(normCode, phone, ip, false, 'Code not found');
      return res.status(404).json({ error: 'Code not found' });
    }
    if (codeRecord.is_used && codeRecord.use_count >= codeRecord.max_uses) {
      await logAttempt(normCode, phone, ip, false, 'Already used');
      return res.status(400).json({ error: 'Code already used' });
    }
    if (codeRecord.expires_at && new Date(codeRecord.expires_at) < new Date()) {
      await logAttempt(normCode, phone, ip, false, 'Expired');
      return res.status(400).json({ error: 'Code expired' });
    }
    const { data: premium } = await supabase.from('premium_content').select('*').eq('product_id', codeRecord.product_id).eq('is_active', true).order('sort_order');
    // customer upsert
    const { data: existing, error: fetchError } = await supabase.from('customers').select('*').eq('phone', normPhone).single();
    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;
    let customer;
    if (existing) {
      const updatedProducts = Array.from(new Set([...existing.verified_products, codeRecord.id]));
      const { data: upd, error: updErr } = await supabase.from('customers').update({
        verified_products: updatedProducts,
        last_access_at: new Date().toISOString()
      }).eq('phone', normPhone).select().single();
      if (updErr) throw updErr;
      customer = upd;
    } else {
      const { data: newCust, error: insErr } = await supabase.from('customers').insert({
        phone: normPhone,
        name,
        email: email || null,
        verified_products: [codeRecord.id],
        joined_at: new Date().toISOString(),
        last_access_at: new Date().toISOString()
      }).select().single();
      if (insErr) throw insErr;
      customer = newCust;
    }
    await supabase.from('verification_codes').update({
      is_used: true,
      used_at: new Date().toISOString(),
      used_by_phone: normPhone,
      used_by_name: name,
      use_count: codeRecord.use_count + 1
    }).eq('id', codeRecord.id);
    const token = generateToken({
      customer_id: customer.id,
      phone: customer.phone,
      verified_products: customer.verified_products,
      role: normPhone === process.env.ADMIN_PHONE ? 'admin' : 'customer'
    });
    await logAttempt(normCode, phone, ip, true, 'Success');
    res.json({
      success: true,
      session: { token, customer: { id: customer.id, name: customer.name, phone: customer.phone } },
      product: codeRecord.products,
      premium_content: organizePremiumContent(premium),
      progress: customer.progress || {}
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/verify-session', async (req, res) => {
  const { token } = req.body;
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ valid: false });
  const { data: customer, error } = await supabase.from('customers').select('*').eq('id', decoded.customer_id).single();
  if (error || !customer) return res.status(401).json({ valid: false });
  const { data: premium } = await supabase.from('premium_content').select('*').in('product_id', customer.verified_products).eq('is_active', true);
  res.json({ valid: true, customer: { id: customer.id, name: customer.name, phone: customer.phone }, premium_content: organizePremiumContent(premium), progress: customer.progress });
});

app.post('/api/update-progress', authenticate, async (req, res) => {
  const { product_id, progress_type, content_id, completed } = req.body;
  const { data: customer } = await supabase.from('customers').select('progress').eq('id', req.user.customer_id).single();
  const progress = customer.progress || {};
  if (!progress[product_id]) progress[product_id] = {};
  if (!progress[product_id][progress_type]) progress[product_id][progress_type] = {};
  progress[product_id][progress_type][content_id] = { completed, completed_at: completed ? new Date().toISOString() : null };
  await supabase.from('customers').update({ progress, last_access_at: new Date().toISOString() }).eq('id', req.user.customer_id);
  res.json({ success: true, progress: progress[product_id] });
});

app.post('/api/save-notes', authenticate, async (req, res) => {
  const { product_id, notes } = req.body;
  const { data: customer } = await supabase.from('customers').select('notes').eq('id', req.user.customer_id).single();
  const current = customer.notes || {};
  current[product_id] = notes;
  await supabase.from('customers').update({ notes: current }).eq('id', req.user.customer_id);
  res.json({ success: true });
});

// ==========================================
// Admin API
// ==========================================
const adminRouter = express.Router();

adminRouter.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  if (phone === process.env.ADMIN_PHONE && password === process.env.ADMIN_PASSWORD) {
    const token = generateToken({ phone: process.env.ADMIN_PHONE, role: 'admin' });
    res.json({ token, admin: { phone: process.env.ADMIN_PHONE, name: 'Suman' } });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

adminRouter.post('/confirm-upi', authenticateAdmin, async (req, res) => {
  const { orderId } = req.body;
  const { error } = await supabase.from('orders').update({ status: 'upi_confirmed', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', orderId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

adminRouter.post('/confirm-cod', authenticateAdmin, async (req, res) => {
  const { orderId } = req.body;
  const { error } = await supabase.from('orders').update({ status: 'cod_confirmed', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', orderId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

adminRouter.get('/orders', authenticateAdmin, async (req, res) => {
  let query = supabase.from('orders').select('*').order('created_at', { ascending: false });
  if (req.query.type === 'upi') query = query.eq('payment_method', 'upi').in('status', ['upi_pending', 'upi_confirmed']);
  if (req.query.type === 'cod') query = query.eq('payment_method', 'cod').in('status', ['cod_pending', 'cod_confirmed']);
  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  res.json({ orders: data });
});

adminRouter.get('/stats', authenticateAdmin, async (req, res) => {
  const { data: orders } = await supabase.from('orders').select('status, amount');
  const { data: customers, count: customerCount } = await supabase.from('customers').select('id', { count: 'exact', head: true });
  const { data: products } = await supabase.from('products').select('id').eq('active', true);
  const stats = {
    totalRevenue: orders.filter(o => o.status === 'upi_confirmed' || o.status === 'cod_confirmed').reduce((s, o) => s + o.amount, 0),
    totalOrders: orders.length,
    pendingOrders: orders.filter(o => o.status === 'upi_pending' || o.status === 'cod_pending').length,
    totalCustomers: customerCount || 0,
    activeProducts: products?.length || 0
  };
  res.json(stats);
});

adminRouter.post('/add-product', authenticateAdmin, async (req, res) => {
  const prod = req.body;
  const { data, error } = await supabase.from('products').insert({
    id: prod.id.toLowerCase(),
    name: prod.name,
    emoji: prod.emoji,
    price: prod.price,
    original_price: prod.original,
    description: prod.description,
    image_url: prod.image,
    stock: prod.stock || 10,
    steps: prod.steps || [],
    cod_allowed: prod.cod_allowed !== undefined ? prod.cod_allowed : true,
    active: true,
    created_at: new Date().toISOString()
  }).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, product: data[0] });
});

adminRouter.post('/generate-codes', authenticateAdmin, async (req, res) => {
  const { product_id, quantity, batch_id, expires_days } = req.body;
  const codes = [];
  const now = new Date();
  const dateStr = now.toISOString().slice(2,10).replace(/-/g,'');
  const prefix = product_id.substring(0,3).toUpperCase();
  for (let i=0; i<quantity; i++) {
    const serial = String(i+1).padStart(3,'0');
    const random = Math.random().toString(36).substring(2,5).toUpperCase();
    codes.push(`SS${dateStr}-${prefix}-${serial}-${random}`);
  }
  const { error } = await supabase.from('verification_codes').insert(codes.map(c => ({
    code: c, product_id, batch_id: batch_id || `BATCH_${dateStr}`,
    expires_at: expires_days ? new Date(now.getTime() + expires_days*24*60*60*1000) : null
  })));
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, generated: codes.length, codes });
});

app.use('/api/admin', adminRouter);

// ==========================================
// Meesho Automation (import service & cron)
// ==========================================
const MeeshoService = require('./services/MeeshoService');
require('./cron/jobs');

// ==========================================
// Telegram Webhook Route (FIXED)
// ==========================================
app.post('/telegram-webhook', require('./telegram-bot'));

// ==========================================
// Start Server
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SmartSolve server on port ${PORT}`);
  console.log(`💳 UPI ID: ${process.env.UPI_ID || '9123869646@fam'}`);
});