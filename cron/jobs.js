const cron = require('node-cron');
const MeeshoService = require('../services/MeeshoService');

// Price sync every 4 hours (safer)
cron.schedule('0 */4 * * *', async () => {
  console.log('[CRON] Price sync started');
  if (process.env.MEESHO_AUTO_PRICE_SYNC === 'true') {
    await MeeshoService.syncAllPrices();
  }
});

// Delivery tracking every 2 hours
cron.schedule('0 */2 * * *', async () => {
  console.log('[CRON] Delivery tracking started');
  if (process.env.MEESHO_AUTO_ORDER_FORWARD === 'true') {
    await MeeshoService.trackDeliveries();
  }
});

// Follow-ups every hour
cron.schedule('0 * * * *', async () => {
  console.log('[CRON] Follow-up processing started');
  await MeeshoService.processFollowUps();
});

// Daily profit report at 9 AM
cron.schedule('0 9 * * *', async () => {
  console.log('[CRON] Daily profit report');
  const report = await MeeshoService.generateProfitReport('day');
  await MeeshoService.sendTelegramAlert(`📊 Daily Report\nRevenue: ₹${report.revenue}\nProfit: ₹${report.netProfit}\nRTO: ${report.rtoRate}%`);
});

// Weekly report on Sunday at 9 AM
cron.schedule('0 9 * * 0', async () => {
  console.log('[CRON] Weekly profit report');
  const report = await MeeshoService.generateProfitReport('week');
  await MeeshoService.sendTelegramAlert(`📈 Weekly Report\nRevenue: ₹${report.revenue}\nProfit: ₹${report.netProfit}\nMargin: ${report.marginPercent}%`);
});