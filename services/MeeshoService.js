const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');

puppeteer.use(StealthPlugin());

class MeeshoAutomationService {
  constructor() {
    this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    this.browser = null;
  }

  randomDelay(min, max) {
    const delay = Math.random() * (max - min) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  async syncAllPrices() {
    const { data: mappings } = await this.supabase
      .from('product_mappings')
      .select('*, products(*)')
      .eq('auto_sync', true);

    const results = { updated: 0, errors: [], alerts: [] };

    for (const mapping of mappings) {
      await this.randomDelay(5000, 30000);
      try {
        const meeshoData = await this.scrapeMeeshoProduct(mapping.meesho_url);
        if (meeshoData.price !== mapping.source_price) {
          const newPrice = this.calculatePrice(meeshoData.price, mapping.min_margin, mapping.max_margin);
          const margin = ((newPrice - meeshoData.price) / newPrice * 100).toFixed(2);
          await this.supabase
            .from('products')
            .update({ price: newPrice, updated_at: new Date() })
            .eq('id', mapping.product_id);
          await this.supabase
            .from('product_mappings')
            .update({
              source_price: meeshoData.price,
              current_stock: meeshoData.stock,
              last_sync: new Date()
            })
            .eq('id', mapping.id);
          await this.logAutomation('price_sync', 'success', `Updated ${mapping.products.name}: ₹${newPrice} (${margin}% margin)`);
          results.updated++;
          if (margin < 20) results.alerts.push(`⚠️ Low margin: ${mapping.products.name} (${margin}%)`);
        }
      } catch (error) {
        results.errors.push(`${mapping.products.name}: ${error.message}`);
        await this.logAutomation('price_sync', 'failed', error.message);
      }
    }
    return results;
  }

  calculatePrice(sourcePrice, minMargin, maxMargin) {
    let price = Math.ceil(sourcePrice / (1 - maxMargin / 100));
    price = Math.ceil(price / 10) * 10 - 1;
    const actualMargin = ((price - sourcePrice) / price) * 100;
    if (actualMargin < minMargin) {
      price = Math.ceil(sourcePrice / (1 - minMargin / 100));
      price = Math.ceil(price / 10) * 10 - 1;
    }
    return price;
  }

  // SAFE: manual order alert (no headless ordering)
  async forwardOrder(orderId) {
    const { data: orderData } = await this.supabase
      .from('orders')
      .select('*, items, customer_name, customer_phone, shipping_address')
      .eq('id', orderId)
      .single();
    if (!orderData) throw new Error('Order not found');
    const firstItem = orderData.items[0];
    const { data: mapping } = await this.supabase
      .from('product_mappings')
      .select('*, meesho_suppliers(*)')
      .eq('product_id', firstItem.id)
      .single();
    if (!mapping) throw new Error('No Meesho mapping found');

    const productUrl = mapping.meesho_url;
    const customerInfo = `Name: ${orderData.customer_name}\nPhone: ${orderData.customer_phone}\nAddress: ${orderData.shipping_address}`;
    await this.sendTelegramAlert(
      `🛒 *Manual Order Required*\n\n` +
      `Customer: ${orderData.customer_name}\nPhone: ${orderData.customer_phone}\n` +
      `Product: ${firstItem.name}\nAmount: ₹${orderData.total_amount}\n\n` +
      `👉 [Open Product](${productUrl})\n\n` +
      `📋 *Customer Details to paste:*\n\`\`\`\n${customerInfo}\n\`\`\``
    );
    await this.supabase.from('meesho_orders').insert({
      order_id: orderId,
      meesho_status: 'pending_forward',
      auto_forwarded: false,
      created_at: new Date()
    });
    await this.logAutomation('order_forward', 'manual_required', `Order ${orderId} – manual placement needed`);
    return { success: true, manual: true, productUrl };
  }

  async scrapeMeeshoProduct(url) {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
    ];
    await page.setUserAgent(userAgents[Math.floor(Math.random() * userAgents.length)]);
    await page.goto(url, { waitUntil: 'networkidle2' });
    const data = await page.evaluate(() => {
      const name = document.querySelector('h1')?.innerText?.trim();
      const priceEl = document.querySelector('[class*="price"]');
      const price = parseInt(priceEl?.innerText?.replace(/[^0-9]/g, '')) || 0;
      const desc = document.querySelector('[class*="description"]')?.innerText?.trim();
      const images = Array.from(document.querySelectorAll('img[src*="meesho"]')).map(img => img.src);
      return { name, price, description: desc, images, stock: 100, id: url.split('/').pop() };
    });
    await browser.close();
    return data;
  }

  async trackDeliveries() {
    const { data: pending } = await this.supabase
      .from('meesho_orders')
      .select('*, orders(*)')
      .in('meesho_status', ['placed', 'shipped', 'out_for_delivery']);

    for (const mo of pending) {
      await this.randomDelay(5000, 15000);
      try {
        const tracking = await this.fetchTracking(mo.meesho_order_number);
        await this.supabase
          .from('meesho_orders')
          .update({ meesho_status: tracking.status, tracking_data: tracking, updated_at: new Date() })
          .eq('id', mo.id);
        if (tracking.status === 'delivered' && !mo.delivered_at) {
          await this.handleDelivery(mo);
        }
        if (tracking.status.includes('rto') || tracking.status.includes('return')) {
          await this.handleRTO(mo, tracking);
        }
      } catch (error) {
        await this.logAutomation('delivery_track', 'failed', `Order ${mo.meesho_order_number}: ${error.message}`);
      }
    }
  }

  async handleDelivery(meeshoOrder) {
    await this.supabase
      .from('meesho_orders')
      .update({ delivered_at: new Date(), meesho_status: 'delivered' })
      .eq('id', meeshoOrder.id);

    const productId = meeshoOrder.orders.items[0].id;
    const code = await this.generateVerificationCode(productId);
    await this.sendTelegramAlert(
      `📦 *Order Delivered* (Auto-verified)\n` +
      `Customer: ${meeshoOrder.orders.customer_name}\nPhone: ${meeshoOrder.orders.customer_phone}\n` +
      `Order: #${meeshoOrder.orders.order_number}\n` +
      `Verification Code: \`${code}\``
    );
    await this.logAutomation('auto_verify', 'success', `Generated code ${code} for ${meeshoOrder.orders.customer_phone}`);
    await this.scheduleFollowUps(meeshoOrder.order_id, meeshoOrder.orders.customer_phone);
  }

  async generateVerificationCode(productId) {
    const code = `SS${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
    await this.supabase.from('verification_codes').insert({
      product_id: productId,
      code,
      is_used: false,
      created_at: new Date()
    });
    return code;
  }

  async handleRTO(meeshoOrder, trackingData) {
    if (meeshoOrder.rto_detected) return;
    const lossAmount = meeshoOrder.orders.total_amount * 0.2;
    await this.supabase.from('rto_records').insert({
      meesho_order_id: meeshoOrder.id,
      loss_amount: lossAmount,
      detected_at: new Date()
    });
    await this.supabase
      .from('meesho_orders')
      .update({ rto_detected: true, rto_data: trackingData, meesho_status: 'rto' })
      .eq('id', meeshoOrder.id);

    const productId = meeshoOrder.orders.items[0].id;
    const rtoRate = await this.calculateRTORate(productId);
    if (rtoRate > (process.env.MEESHO_RTO_THRESHOLD || 15)) {
      await this.supabase
        .from('products')
        .update({ is_active: false, updated_at: new Date() })
        .eq('id', productId);
      await this.supabase
        .from('rto_records')
        .update({ product_paused: true })
        .eq('meesho_order_id', meeshoOrder.id);
      await this.sendTelegramAlert(`🚨 AUTO-PAUSED: Product ${productId} has ${rtoRate}% RTO rate`);
    }
    await this.logAutomation('rto_detect', 'success', `RTO for ${meeshoOrder.meesho_order_number}, loss ₹${lossAmount}`);
  }

  async calculateRTORate(productId) {
    const { data: mappings } = await this.supabase
      .from('product_mappings')
      .select('product_id')
      .eq('product_id', productId);
    if (!mappings || mappings.length === 0) return 0;
    const { data: orders } = await this.supabase
      .from('meesho_orders')
      .select('rto_detected')
      .in('order_id', mappings.map(m => m.product_id));
    if (!orders || orders.length === 0) return 0;
    const rtoCount = orders.filter(o => o.rto_detected).length;
    return (rtoCount / orders.length * 100).toFixed(2);
  }

  async generateProfitReport(period = 'week') {
    const startDate = new Date();
    if (period === 'week') startDate.setDate(startDate.getDate() - 7);
    if (period === 'month') startDate.setDate(startDate.getDate() - 30);
    if (period === 'day') startDate.setDate(startDate.getDate() - 1);

    const { data: orders } = await this.supabase
      .from('orders')
      .select('*, meesho_orders(*), items')
      .gte('created_at', startDate.toISOString())
      .in('status', ['upi_confirmed', 'cod_confirmed']);

    let revenue = 0, meeshoCosts = 0, rtoLosses = 0, rtoCount = 0;
    for (const order of orders) {
      revenue += order.total_amount;
      if (order.meesho_orders?.[0]) {
        const mo = order.meesho_orders[0];
        const estimatedCost = order.total_amount * 0.75;
        meeshoCosts += estimatedCost;
        if (mo.rto_detected) {
          rtoLosses += order.total_amount * 0.2;
          rtoCount++;
        }
      }
    }
    const netProfit = revenue - meeshoCosts - rtoLosses;
    const margin = revenue ? (netProfit / revenue * 100).toFixed(2) : 0;
    const rtoRate = orders.length ? (rtoCount / orders.length * 100).toFixed(2) : 0;

    const report = {
      period,
      revenue,
      meeshoCosts: Math.round(meeshoCosts),
      rtoLosses: Math.round(rtoLosses),
      netProfit: Math.round(netProfit),
      marginPercent: margin,
      totalOrders: orders.length,
      rtoCount,
      rtoRate,
      generatedAt: new Date()
    };
    await this.supabase.from('profit_reconciliation').insert({
      period_start: startDate,
      period_end: new Date(),
      total_revenue: revenue,
      total_meesho_costs: meeshoCosts,
      total_rto_losses: rtoLosses,
      net_profit: netProfit,
      profit_margin_percent: margin,
      order_count: orders.length,
      rto_count: rtoCount,
      rto_rate_percent: rtoRate
    });
    return report;
  }

  async importProductFromMeesho(meeshoUrl, supplierId, margin = 25) {
    const data = await this.scrapeMeeshoProduct(meeshoUrl);
    const { data: product } = await this.supabase
      .from('products')
      .insert({
        id: data.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12),
        name: data.name,
        emoji: '📦',
        price: this.calculatePrice(data.price, margin, 50),
        description: data.description,
        stock: data.stock,
        image_url: data.images?.[0],
        active: true,
        created_at: new Date()
      })
      .select()
      .single();

    await this.supabase.from('product_mappings').insert({
      product_id: product.id,
      supplier_id: supplierId,
      meesho_url: meeshoUrl,
      meesho_product_id: data.id,
      source_price: data.price,
      current_stock: data.stock,
      min_margin: margin,
      max_margin: 50
    });
    const codes = [];
    for (let i = 0; i < 10; i++) {
      codes.push(await this.generateVerificationCode(product.id));
    }
    return { product, codes };
  }

  async scheduleFollowUps(orderId, phone) {
    const now = new Date();
    await this.supabase.from('follow_ups').insert([
      {
        order_id: orderId,
        type: 'delivery_feedback',
        scheduled_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        customer_phone: phone
      },
      {
        order_id: orderId,
        type: 'repeat_offer',
        scheduled_at: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
        customer_phone: phone
      }
    ]);
  }

  async processFollowUps() {
    const { data: pending } = await this.supabase
      .from('follow_ups')
      .select('*, orders(*)')
      .eq('status', 'pending')
      .lte('scheduled_at', new Date().toISOString());

    for (const fu of pending) {
      try {
        await this.sendTelegramAlert(
          `📱 *Follow-up Reminder*\n` +
          `Customer: ${fu.orders.customer_name} (${fu.customer_phone})\n` +
          `Type: ${fu.type}\n` +
          `Scheduled for: ${new Date(fu.scheduled_at).toLocaleString()}`
        );
        await this.supabase.from('follow_ups').update({ status: 'sent', sent_at: new Date() }).eq('id', fu.id);
      } catch (error) {
        await this.supabase.from('follow_ups').update({ status: 'failed' }).eq('id', fu.id);
      }
    }
  }

  async logAutomation(type, status, message) {
    await this.supabase.from('automation_logs').insert({ type, status, message, created_at: new Date() });
    if (status === 'failed' && type !== 'price_sync') {
      await this.sendTelegramAlert(`❌ Automation Failed: ${type}\n${message}`);
    }
  }

  async sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.ADMIN_TELEGRAM_ID;
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown'
    }).catch(e => console.error('Telegram send error', e.message));
  }

  decryptPassword(encrypted) {
    const decipher = crypto.createDecipher('aes-256-cbc', process.env.ENCRYPTION_KEY);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  async fetchTracking(orderNumber) {
    // Placeholder – implement Meesho tracking scraping or API
    return { status: 'in_transit', awb: orderNumber };
  }
}

module.exports = new MeeshoAutomationService();