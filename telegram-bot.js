const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.TELEGRAM_ADMIN_ID;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Create bot instance (polling disabled for webhook)
const bot = new TelegramBot(token, { polling: false });

// ==========================================
// Admin Protection
// ==========================================
function isAdmin(msg) {
  return String(msg.chat.id) === String(adminId);
}

// ==========================================
// Import Meesho Commands
// ==========================================
const meeshoCommands = require('./bot/commands/meesho');
meeshoCommands(bot);

// ==========================================
// Existing Core Commands (Products, Orders, etc.)
// ==========================================

async function handleStart(msg) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId,
    `🤖 *SmartSolve Boss Bot*\n\nWelcome! Send /help for commands.`,
    { parse_mode: 'Markdown' }
  );
}

async function handleHelp(msg) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId,
    `📚 *Commands*\n\n` +
    `*/addproduct* – Add new product (interactive)\n` +
    `*/products* – List all products\n` +
    `*/price [id] [price]* – Change price\n` +
    `*/stock [id] [qty]* – Set stock\n` +
    `*/addstock [id] [qty]* – Add to stock\n` +
    `*/orders* – Today's orders\n` +
    `*/upiorders* – Pending UPI orders\n` +
    `*/codorders* – Pending COD orders\n` +
    `*/confirmupi [order-id]* – Confirm UPI payment\n` +
    `*/confirmcod [order-id]* – Confirm COD payment\n` +
    `*/rejectcod [order-id]* – Reject COD order\n` +
    `*/codes [product] [qty]* – Generate codes\n` +
    `*/revenue* – Business stats\n` +
    `*/lowstock* – Low stock alerts\n` +
    `*/banner [text]* – Update homepage banner\n` +
    `*/exportproducts* – Export CSV\n` +
    `*/help* – Show this help\n\n` +
    `*Meesho Automation:*\n` +
    `*/suppliers* – List Meesho suppliers\n` +
    `*/syncprices* – Sync prices from Meesho\n` +
    `*/margins* – View current margins\n` +
    `*/forwardorder [id]* – Forward order to Meesho (manual alert)\n` +
    `*/meeshoorders* – Track forwarded orders\n` +
    `*/rtos* – View RTO records\n` +
    `*/rtorate [product-id]* – RTO rate for product\n` +
    `*/profit [day|week|month]* – Profit report\n` +
    `*/importproduct [url] [margin]* – Import from Meesho\n` +
    `*/automation* – Automation status\n` +
    `*/logs* – Automation logs`,
    { parse_mode: 'Markdown' }
  );
}

async function handleProducts(msg) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (!products?.length) return bot.sendMessage(chatId, 'No products found.');
    let text = `📦 *Products* (${products.length})\n\n`;
    products.forEach(p => {
      text += `${p.emoji} *${p.name}* – ₹${p.price} | Stock: ${p.stock}\nID: \`${p.id}\`\n\n`;
    });
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to fetch products.');
  }
}

async function handlePrice(msg, match) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  const [, id, price] = match;
  const newPrice = parseInt(price);
  if (isNaN(newPrice)) return bot.sendMessage(chatId, '❌ Invalid price.');
  try {
    const { data, error } = await supabase
      .from('products')
      .update({ price: newPrice })
      .eq('id', id)
      .select('name');
    if (error || !data?.length) return bot.sendMessage(chatId, `❌ Product "${id}" not found.`);
    await bot.sendMessage(chatId, `✅ Price of *${data[0].name}* updated to ₹${newPrice}`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to update price.');
  }
}

async function handleStock(msg, match) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  const [, id, qty] = match;
  const newStock = parseInt(qty);
  if (isNaN(newStock)) return bot.sendMessage(chatId, '❌ Invalid stock.');
  try {
    const { data, error } = await supabase
      .from('products')
      .update({ stock: newStock })
      .eq('id', id)
      .select('name');
    if (error || !data?.length) return bot.sendMessage(chatId, `❌ Product "${id}" not found.`);
    await bot.sendMessage(chatId, `✅ Stock of *${data[0].name}* set to ${newStock}`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to update stock.');
  }
}

async function handleAddStock(msg, match) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  const [, id, qty] = match;
  const addQty = parseInt(qty);
  if (isNaN(addQty)) return bot.sendMessage(chatId, '❌ Invalid quantity.');
  try {
    const { data: prod, error } = await supabase
      .from('products')
      .select('stock, name')
      .eq('id', id)
      .single();
    if (error || !prod) return bot.sendMessage(chatId, `❌ Product "${id}" not found.`);
    const newStock = prod.stock + addQty;
    await supabase.from('products').update({ stock: newStock }).eq('id', id);
    await bot.sendMessage(chatId, `✅ Added +${addQty} to *${prod.name}*. New stock: ${newStock}`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to add stock.');
  }
}

async function handleOrders(msg) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  const today = new Date().toISOString().split('T')[0];
  try {
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .gte('created_at', today)
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (!orders?.length) return bot.sendMessage(chatId, 'No orders today.');
    const total = orders
      .filter(o => o.status === 'upi_confirmed' || o.status === 'cod_confirmed')
      .reduce((s, o) => s + o.amount, 0);
    let text = `🛒 *Today's Orders* (${orders.length})\n💰 Total: ₹${total}\n\n`;
    orders.slice(0, 5).forEach((o, i) => {
      text += `${i+1}. *${o.customer_name}* – ₹${o.amount} (${o.payment_method})\nStatus: ${o.status}\n`;
    });
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to fetch orders.');
  }
}

async function handleUpiOrders(msg) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  try {
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .eq('payment_method', 'upi')
      .in('status', ['upi_pending', 'upi_confirmed'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (!orders?.length) return bot.sendMessage(chatId, 'No UPI orders.');
    let text = `💳 *UPI Orders* (${orders.length})\n\n`;
    orders.forEach((o, i) => {
      const icon = o.status === 'upi_pending' ? '⏳' : '✅';
      text += `${i+1}. ${icon} *${o.customer_name}* – ₹${o.amount}\n📞 ${o.customer_phone}\n🆔 \`${o.id}\`\n\n`;
    });
    text += `Use /confirmupi [order-id] to mark paid.`;
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to fetch UPI orders.');
  }
}

async function handleCodOrders(msg) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  try {
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .eq('payment_method', 'cod')
      .in('status', ['cod_pending', 'cod_confirmed'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (!orders?.length) return bot.sendMessage(chatId, 'No COD orders.');
    let text = `🚚 *COD Orders* (${orders.length})\n\n`;
    orders.forEach((o, i) => {
      const icon = o.status === 'cod_pending' ? '⏳' : '✅';
      text += `${i+1}. ${icon} *${o.customer_name}* – ₹${o.amount}\n📞 ${o.customer_phone}\n🆔 \`${o.id}\`\n\n`;
    });
    text += `Use /confirmcod [order-id] to mark paid.`;
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to fetch COD orders.');
  }
}

async function handleConfirmUpi(msg, match) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  const orderId = match[1];
  try {
    const { data, error } = await supabase
      .from('orders')
      .update({ status: 'upi_confirmed', paid_at: new Date().toISOString() })
      .eq('id', orderId)
      .select('customer_name, amount')
      .single();
    if (error || !data) return bot.sendMessage(chatId, 'Order not found or already confirmed.');
    await bot.sendMessage(chatId, `✅ UPI order from *${data.customer_name}* confirmed. Amount ₹${data.amount} received.`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to confirm order.');
  }
}

async function handleConfirmCod(msg, match) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  const orderId = match[1];
  try {
    const { data, error } = await supabase
      .from('orders')
      .update({ status: 'cod_confirmed', paid_at: new Date().toISOString() })
      .eq('id', orderId)
      .select('customer_name, amount')
      .single();
    if (error || !data) return bot.sendMessage(chatId, 'Order not found or already confirmed.');
    await bot.sendMessage(chatId, `✅ COD order from *${data.customer_name}* confirmed. Amount ₹${data.amount} received.`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to confirm order.');
  }
}

async function handleRejectCod(msg, match) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  const orderId = match[1];
  try {
    const { error } = await supabase
      .from('orders')
      .update({ status: 'cod_rejected' })
      .eq('id', orderId);
    if (error) return bot.sendMessage(chatId, 'Order not found.');
    await bot.sendMessage(chatId, `❌ COD order ${orderId} rejected.`);
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to reject order.');
  }
}

async function handleCodes(msg, match) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  const [, productId, qty] = match;
  const quantity = Math.min(parseInt(qty), 50);
  if (isNaN(quantity) || quantity < 1) return bot.sendMessage(chatId, '❌ Invalid quantity.');
  try {
    const { data: product, error } = await supabase
      .from('products')
      .select('name, emoji')
      .eq('id', productId)
      .single();
    if (error || !product) return bot.sendMessage(chatId, 'Product not found.');
    const now = new Date();
    const dateStr = now.toISOString().slice(2, 10).replace(/-/g, '');
    const prefix = productId.substring(0, 3).toUpperCase();
    const codes = [];
    for (let i = 0; i < quantity; i++) {
      const serial = String(i + 1).padStart(3, '0');
      const random = Math.random().toString(36).substring(2, 5).toUpperCase();
      codes.push(`SS${dateStr}-${prefix}-${serial}-${random}`);
    }
    const { error: insertError } = await supabase
      .from('verification_codes')
      .insert(codes.map(c => ({ code: c, product_id: productId, is_used: false, created_at: now.toISOString() })));
    if (insertError) throw insertError;
    const codeList = codes.join('\n');
    await bot.sendMessage(chatId, `🎫 *${quantity} codes* for ${product.emoji} ${product.name}\n\n\`\`\`\n${codeList}\n\`\`\``, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to generate codes.');
  }
}

async function handleRevenue(msg) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  try {
    const { data: orders, error } = await supabase.from('orders').select('amount, status, created_at');
    if (error) throw error;
    const paid = orders.filter(o => o.status === 'upi_confirmed' || o.status === 'cod_confirmed');
    const total = paid.reduce((s, o) => s + o.amount, 0);
    const today = new Date().toISOString().split('T')[0];
    const todayRev = paid.filter(o => o.created_at >= today).reduce((s, o) => s + o.amount, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weekRev = paid.filter(o => o.created_at >= weekAgo).reduce((s, o) => s + o.amount, 0);
    const monthAgo = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const monthRev = paid.filter(o => o.created_at >= monthAgo).reduce((s, o) => s + o.amount, 0);
    await bot.sendMessage(chatId, `📊 *Revenue*\n\nToday: ₹${todayRev}\nThis week: ₹${weekRev}\nThis month: ₹${monthRev}\nTotal: ₹${total}`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to calculate revenue.');
  }
}

async function handleLowStock(msg) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .eq('active', true)
      .lt('stock', 5)
      .gt('stock', 0);
    if (error) throw error;
    if (!products?.length) return bot.sendMessage(chatId, 'No low stock items.');
    let text = `⚠️ *Low Stock* (${products.length})\n\n`;
    products.forEach(p => {
      text += `${p.emoji} *${p.name}* – ${p.stock} left\nID: \`${p.id}\`\n`;
    });
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to fetch low stock items.');
  }
}

async function handleBanner(msg, match) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  const bannerText = match[1];
  try {
    await supabase.from('site_settings').upsert({ key: 'homepage_banner', value: bannerText, active: true, updated_at: new Date().toISOString() });
    await bot.sendMessage(chatId, `✅ Banner updated: "${bannerText}"`);
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to update banner.');
  }
}

async function handleExportProducts(msg) {
  if (!isAdmin(msg)) return;
  const chatId = msg.chat.id;
  try {
    const { data: products, error } = await supabase.from('products').select('*');
    if (error) throw error;
    if (!products?.length) return bot.sendMessage(chatId, 'No products.');
    const csvRows = [['ID', 'Name', 'Emoji', 'Price', 'Original', 'Stock', 'Active', 'COD Allowed', 'Created']];
    products.forEach(p => {
      const row = [p.id, `"${p.name.replace(/"/g, '""')}"`, p.emoji, p.price, p.original_price || '', p.stock, p.active, p.cod_allowed, p.created_at];
      csvRows.push(row);
    });
    const csvContent = csvRows.map(row => row.join(',')).join('\n');
    await bot.sendDocument(chatId, Buffer.from(csvContent), { filename: `products_${Date.now()}.csv`, caption: 'Products export' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to export products.');
  }
}

// Register core commands
bot.onText(/\/start/, handleStart);
bot.onText(/\/help/, handleHelp);
bot.onText(/\/products/, handleProducts);
bot.onText(/\/price (\w+) (\d+)/, (msg, match) => handlePrice(msg, match));
bot.onText(/\/stock (\w+) (\d+)/, (msg, match) => handleStock(msg, match));
bot.onText(/\/addstock (\w+) (\d+)/, (msg, match) => handleAddStock(msg, match));
bot.onText(/\/orders/, handleOrders);
bot.onText(/\/upiorders/, handleUpiOrders);
bot.onText(/\/codorders/, handleCodOrders);
bot.onText(/\/confirmupi (\S+)/, (msg, match) => handleConfirmUpi(msg, match));
bot.onText(/\/confirmcod (\S+)/, (msg, match) => handleConfirmCod(msg, match));
bot.onText(/\/rejectcod (\S+)/, (msg, match) => handleRejectCod(msg, match));
bot.onText(/\/codes (\w+) (\d+)/, (msg, match) => handleCodes(msg, match));
bot.onText(/\/revenue/, handleRevenue);
bot.onText(/\/lowstock/, handleLowStock);
bot.onText(/\/banner (.+)/, (msg, match) => handleBanner(msg, match));
bot.onText(/\/exportproducts/, handleExportProducts);

// ==========================================
// Webhook Handler for Vercel/Railway
// ==========================================
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    await bot.processUpdate(req.body);
    res.status(200).send('OK');
  } else {
    res.status(200).send('Bot is ready');
  }
};