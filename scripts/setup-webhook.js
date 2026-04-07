/**
 * Скрипт для установки Telegram webhook.
 *
 * Использование:
 *   BOT_TOKEN=xxx VERCEL_URL=your-project.vercel.app node scripts/setup-webhook.js
 *
 * Или после деплоя:
 *   npm run setup-webhook
 */

const BOT_TOKEN = process.env.BOT_TOKEN;
const VERCEL_URL = process.env.VERCEL_URL;

if (!BOT_TOKEN || !VERCEL_URL) {
  console.error(
    "Установите переменные окружения BOT_TOKEN и VERCEL_URL\n" +
      "Пример: BOT_TOKEN=123:ABC VERCEL_URL=my-bot.vercel.app node scripts/setup-webhook.js"
  );
  process.exit(1);
}

const webhookUrl = `https://${VERCEL_URL}/api/webhook`;

async function main() {
  console.log(`Устанавливаю webhook: ${webhookUrl}\n`);

  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    }
  );

  const data = await res.json();
  console.log("Ответ Telegram:", JSON.stringify(data, null, 2));

  if (data.ok) {
    console.log("\n✅ Webhook установлен успешно!");
  } else {
    console.error("\n❌ Ошибка установки webhook");
    process.exit(1);
  }
}

main();
