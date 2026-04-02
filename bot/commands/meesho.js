const MeeshoService = require('../../services/MeeshoService');

module.exports = (bot) => {
  // Add Supplier (simple session – you can expand)
  bot.onText(/\/addsupplier/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '📦 Add Meesho Supplier\n\nSend:\n`Supplier Name | Login Email | Password | Default Margin%`', { parse_mode: 'Markdown' });
    // Store session – for simplicity, you can implement a state machine or just add via DB directly.
  });

  bot.onText(/\/suppliers/, async (msg) => {
    const chatId = msg.chat.id;
    const { data } = await MeeshoService.supabase.from('meesho_suppliers').select('*');
    if (!data.length) return bot.sendMessage(chatId, 'No suppliers found.');
    let text = '🏭 *Your Suppliers*\n\n';
    data.forEach(s => {
      text += `📍 ${s.supplier_name}\n   Status: ${s.is_active ? '✅ Active' : '❌ Paused'}\n   Margin: ${s.default_margin}%\n\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/syncprices/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '🔄 Starting price sync...');
    const results = await MeeshoService.syncAllPrices();
    let text = `✅ *Price Sync Complete*\n\nUpdated: ${results.updated} products\n`;
    if (results.alerts.length) text += `\n⚠️ *Alerts:*\n${results.alerts.join('\n')}`;
    if (results.errors.length) text += `\n❌ *Errors:* ${results.errors.length}`;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/setmargin (\S+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const [_, productId, margin] = match;
    await MeeshoService.supabase
      .from('product_mappings')
      .update({ min_margin: parseFloat(margin) })
      .eq('product_id', productId);
    bot.sendMessage(chatId, `✅ Margin updated to ${margin}% for product ${productId}`);
  });

  bot.onText(/\/margins/, async (msg) => {
    const chatId = msg.chat.id;
    const { data } = await MeeshoService.supabase
      .from('product_mappings')
      .select('*, products(name, price), source_price')
      .eq('auto_sync', true);
    if (!data.length) return bot.sendMessage(chatId, 'No active mappings.');
    let text = '💰 *Current Margins*\n\n';
    data.forEach(m => {
      const margin = ((m.products.price - m.source_price) / m.products.price * 100).toFixed(1);
      const emoji = margin < 20 ? '🔴' : margin < 30 ? '🟡' : '🟢';
      text += `${emoji} ${m.products.name}\n   Selling: ₹${m.products.price} | Source: ₹${m.source_price}\n   Margin: ${margin}%\n\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/forwardorder (\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1];
    try {
      const result = await MeeshoService.forwardOrder(orderId);
      bot.sendMessage(chatId, `✅ Order forwarded (manual) – check Telegram alert.`);
    } catch (err) {
      bot.sendMessage(chatId, `❌ Failed to forward: ${err.message}`);
    }
  });

  bot.onText(/\/meeshoorders/, async (msg) => {
    const chatId = msg.chat.id;
    const { data } = await MeeshoService.supabase
      .from('meesho_orders')
      .select('*, orders(order_number, customer_name)')
      .order('created_at', { ascending: false })
      .limit(10);
    if (!data.length) return bot.sendMessage(chatId, 'No Meesho orders yet.');
    let text = '📋 *Recent Meesho Orders*\n\n';
    data.forEach(o => {
      const emoji = { placed: '📦', shipped: '🚚', delivered: '✅', rto: '↩️' }[o.meesho_status] || '❓';
      text += `${emoji} #${o.orders.order_number}\n   Meesho: #${o.meesho_order_number || 'pending'}\n   Status: ${o.meesho_status}\n   Customer: ${o.orders.customer_name}\n\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/rtos/, async (msg) => {
    const chatId = msg.chat.id;
    const { data } = await MeeshoService.supabase
      .from('rto_records')
      .select('*, meesho_orders(meesho_order_number, orders(order_number, total_amount))')
      .order('detected_at', { ascending: false })
      .limit(10);
    if (!data.length) return bot.sendMessage(chatId, 'No RTO records.');
    let text = '↩️ *Recent RTOs*\n\n';
    let totalLoss = 0;
    data.forEach(r => {
      totalLoss += r.loss_amount;
      text += `Order #${r.meesho_orders.orders.order_number}\n   Loss: ₹${r.loss_amount}\n   Date: ${new Date(r.detected_at).toLocaleDateString()}\n   ${r.product_paused ? '⏸️ Product Paused' : '⚠️ Active'}\n\n`;
    });
    text += `\n💸 *Total Loss: ₹${totalLoss}*`;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/rtorate (\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const productId = match[1];
    const rate = await MeeshoService.calculateRTORate(productId);
    const { data: product } = await MeeshoService.supabase.from('products').select('name').eq('id', productId).single();
    bot.sendMessage(chatId, `📊 RTO Rate for ${product?.name || productId}: ${rate}%`);
  });

  bot.onText(/\/profit(?: (\w+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const period = match[1] || 'week';
    bot.sendMessage(chatId, `📊 Generating ${period}ly profit report...`);
    const report = await MeeshoService.generateProfitReport(period);
    let text = `📈 *${period.toUpperCase()}LY PROFIT REPORT*\n\n`;
    text += `💰 Revenue: ₹${report.revenue.toLocaleString()}\n`;
    text += `💸 Meesho Costs: ₹${report.meeshoCosts.toLocaleString()}\n`;
    text += `↩️ RTO Losses: ₹${report.rtoLosses.toLocaleString()}\n`;
    text += `━\n✅ *Net Profit: ₹${report.netProfit.toLocaleString()}*\n`;
    text += `📊 Margin: ${report.marginPercent}%\n\n`;
    text += `📦 Orders: ${report.totalOrders}\n↩️ RTO Rate: ${report.rtoRate}% (${report.rtoCount} orders)`;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/importproduct (\S+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const [_, url, margin] = match;
    bot.sendMessage(chatId, '🔍 Importing product from Meesho...');
    try {
      const { data: supplier } = await MeeshoService.supabase
        .from('meesho_suppliers')
        .select('id')
        .eq('is_active', true)
        .limit(1)
        .single();
      const result = await MeeshoService.importProductFromMeesho(url, supplier.id, parseFloat(margin));
      bot.sendMessage(chatId, `✅ *Product Imported!*\n\nName: ${result.product.name}\nPrice: ₹${result.product.price}\nStock: ${result.product.stock}\nCodes Generated: ${result.codes.length}`);
    } catch (err) {
      bot.sendMessage(chatId, `❌ Import failed: ${err.message}`);
    }
  });

  bot.onText(/\/automation/, async (msg) => {
    const chatId = msg.chat.id;
    const text = `⚙️ *Automation Status*\n\n🔄 Price Sync: Every 4 hours\n📦 Order Forward: Manual alerts\n🚚 Delivery Track: Every 2 hours\n↩️ RTO Monitor: Active\n📱 Follow-ups: Admin reminders\n\nUse /pauseauto [feature] to pause specific automation (not implemented yet)`;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/logs/, async (msg) => {
    const chatId = msg.chat.id;
    const { data } = await MeeshoService.supabase
      .from('automation_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    if (!data.length) return bot.sendMessage(chatId, 'No logs yet.');
    let text = '📋 *Recent Automation Logs*\n\n';
    data.forEach(log => {
      const emoji = log.status === 'success' ? '✅' : log.status === 'failed' ? '❌' : '⚠️';
      const time = new Date(log.created_at).toLocaleTimeString();
      text += `${emoji} [${time}] ${log.type}\n   ${log.message.substring(0, 50)}${log.message.length > 50 ? '...' : ''}\n\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });
};