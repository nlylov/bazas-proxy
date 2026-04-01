// lib/config.js

// Загружаем .env.local только для локальной разработки
// Убедись, что .env.local находится в КОРНЕ проекта, а не в api/ или lib/
if (process.env.NODE_ENV !== 'production') {
  try {
    // Используем path для надежного пути к .env.local из корня проекта
    require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });
  } catch (err) {
    console.warn('dotenv config failed (normal in production, error if local):', err.message);
  }
}

const config = {
  // Конфигурация OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    assistantId: process.env.OPENAI_ASSISTANT_ID,
  },
  // Конфигурация Google Sheets (для временной интеграции)
  google: {
    sheetId: process.env.GOOGLE_SHEET_ID,
    // Важно: читаем как строку, парсить будем в googleSheetService
    serviceAccountCredsJson: process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
  },
  // Конфигурация Vapi (для исходящих звонков)
  vapi: {
    privateApiKey: process.env.VAPI_PRIVATE_API_KEY,
  },
  // CRM API config
  crm: {
    baseUrl: process.env.CRM_BASE_URL || 'https://crm.asap.repair',
    apiKey: process.env.CRM_API_KEY,
  },
  // Настройки CORS
  cors: {
    allowedOrigins: [
      'https://asap.repair',
      'https://www.asap.repair',
      'https://api.asap.repair', // Твой API домен
      'https://sitehandy.netlify.app', // Новый сайт
      process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : null, // Для vercel dev
      process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:5500' : null, // Для Live Server
      // Добавь сюда другие домены, если нужно (например, для тестов)
    ].filter(Boolean), // Убирает null из массива
    options: {
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Version', 'Location-Id', 'X-Request-ID'], // Добавим возможные будущие заголовки
      credentials: true // Если работаешь с куками/сессиями (в данном случае может быть не нужно)
    }
  },
  // Уровень логирования
  logLevel: process.env.LOG_LEVEL || 'info', // По умолчанию 'info'
};

// --- Проверка наличия критически важных переменных ---
let hasConfigError = false;
if (!config.openai.apiKey) {
  console.error('CONFIG ERROR: OPENAI_API_KEY environment variable is not set.');
  hasConfigError = true;
}
if (!config.openai.assistantId) {
  console.error('CONFIG ERROR: OPENAI_ASSISTANT_ID environment variable is not set.');
  hasConfigError = true;
}
if (!config.google.sheetId) {
  console.error('CONFIG ERROR: GOOGLE_SHEET_ID environment variable is not set.');
  hasConfigError = true;
}
if (!config.google.serviceAccountCredsJson) {
  console.error('CONFIG ERROR: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS environment variable is not set.');
  hasConfigError = true;
}
// Проверка CRM API ключа
if (!config.crm.apiKey) {
  console.warn('CONFIG WARN: CRM_API_KEY environment variable is not set. AI Hub will not work.');
}

// В реальном приложении, если ошибки критичны, можно остановить запуск:
// if (hasConfigError && process.env.NODE_ENV !== 'development') {
//    console.error("FATAL: Application cannot start due to missing critical configuration.");
//    process.exit(1);
// }
// -------------------------------------------------------

module.exports = config; // Экспортируем объект конфига