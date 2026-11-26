const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      tg_id BIGINT UNIQUE NOT NULL,
      phone VARCHAR(20) UNIQUE NOT NULL,
      first_name VARCHAR(100) DEFAULT 'Пользователь',
      username VARCHAR(50) UNIQUE,
      is_verified BOOLEAN DEFAULT FALSE,
      is_premium BOOLEAN DEFAULT FALSE,
      is_banned BOOLEAN DEFAULT FALSE,
      stars_balance INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_codes (
      phone VARCHAR(20) PRIMARY KEY,
      code VARCHAR(10) NOT NULL,
      expires_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id INT REFERENCES users(id),
      receiver_id INT REFERENCES users(id),
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('База данных готова!');
}
initDB().catch(console.error);

function generatePhone(prefix) {
  let digits = '';
  for (let i = 0; i < 10; i++) {
    digits += Math.floor(Math.random() * 10);
  }
  return `${prefix}${digits}`;
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const res = await pool.query('SELECT * FROM users WHERE tg_id = $1', [chatId]);

  if (res.rows.length > 0) {
    const user = res.rows[0];
    return bot.sendMessage(
      chatId,
      `👋 С возвращением, ${user.first_name}!\n\n📱 Твой виртуальный номер: \`${user.phone}\`\nИспользуй его для входа на сайт. Коды подтверждения будут приходить сюда.`,
      { parse_mode: 'Markdown' }
    );
  }

  bot.sendMessage(
    chatId,
    '🌐 Добро пожаловать в закрытую сеть!\n\nВыбери регион для выпуска твоего виртуального номера:',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🇺🇸 США (+1)', callback_data: 'reg_+1' },
            { text: '🇷🇺 Россия (+7)', callback_data: 'reg_+7' }
          ]
        ]
      }
    }
  );
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('reg_')) {
    const prefix = data.split('_')[1];
    const existing = await pool.query('SELECT * FROM users WHERE tg_id = $1', [chatId]);
    if (existing.rows.length > 0) {
      return bot.answerCallbackQuery(query.id, { text: 'У тебя уже есть номер!' });
    }

    let phone = generatePhone(prefix);
    const firstName = query.from.first_name || 'User';

    try {
      await pool.query(
        'INSERT INTO users (tg_id, phone, first_name) VALUES ($1, $2, $3)',
        [chatId, phone, firstName]
      );
      await bot.editMessageText(
        `✅ Аккаунт успешно зарегистрирован!\n\n📱 Твой виртуальный номер: \`${phone}\`\n\nТеперь зайди на наш сайт, введи этот номер, и я пришлю тебе код для входа.`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
      );
    } catch (e) {
      bot.sendMessage(chatId, 'Произошла ошибка при создании номера, нажми /start ещё раз.');
    }
  }
});

app.post('/api/auth/send-code', async (req, res) => {
  const cleanPhone = (req.body.phone || '').replace(/[\s\-\(\)]/g, '');
  const userRes = await pool.query('SELECT * FROM users WHERE phone = $1', [cleanPhone]);

  if (userRes.rows.length === 0) {
    return res.status(404).json({ error: 'Номер не найден. Сначала получи его в Telegram-боте!' });
  }
  const user = userRes.rows[0];
  if (user.is_banned) {
    return res.status(403).json({ error: 'Этот аккаунт заблокирован администратором.' });
  }

  const code = Math.floor(10000 + Math.random() * 90000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await pool.query(
    `INSERT INTO auth_codes (phone, code, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = $3`,
    [cleanPhone, code, expiresAt]
  );

  await bot.sendMessage(
    user.tg_id,
    `🔐 Код для входа в веб-версию: *${code}*\n\nНикому не сообщайте этот код!`,
    { parse_mode: 'Markdown' }
  );

  res.json({ success: true });
});

app.post('/api/auth/verify-code', async (req, res) => {
  const cleanPhone = (req.body.phone || '').replace(/[\s\-\(\)]/g, '');
  const code = (req.body.code || '').trim();

  const codeRes = await pool.query(
    'SELECT * FROM auth_codes WHERE phone = $1 AND code = $2 AND expires_at > NOW()',
    [cleanPhone, code]
  );

  if (codeRes.rows.length === 0) {
    return res.status(400).json({ error: 'Неверный или устаревший код!' });
  }

  await pool.query('DELETE FROM auth_codes WHERE phone = $1', [cleanPhone]);
  const userRes = await pool.query('SELECT * FROM users WHERE phone = $1', [cleanPhone]);
  res.json({ success: true, user: userRes.rows[0] });
});

app.get('/api/users', async (req, res) => {
  const users = await pool.query(
    'SELECT id, phone, first_name, username, is_verified, is_premium FROM users WHERE is_banned = FALSE ORDER BY id ASC'
  );
  res.json(users.rows);
});

app.get('/api/messages/:u1/:u2', async (req, res) => {
  const { u1, u2 } = req.params;
  const msgs = await pool.query(
    `SELECT * FROM messages 
     WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
     ORDER BY created_at ASC`,
    [u1, u2]
  );
  res.json(msgs.rows);
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.json({ success: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Неверный пароль администратора' });
  }
});

app.get('/api/admin/users', async (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) return res.status(403).end();
  const users = await pool.query('SELECT * FROM users ORDER BY id DESC');
  res.json(users.rows);
});

app.post('/api/admin/update-user', async (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) return res.status(403).end();
  const { id, is_verified, is_premium, is_banned, stars_balance, phone, username } = req.body;
  await pool.query(
    `UPDATE users SET is_verified = $1, is_premium = $2, is_banned = $3, stars_balance = $4, phone = $5, username = $6 WHERE id = $7`,
    [is_verified, is_premium, is_banned, stars_balance, phone, username || null, id]
  );
  res.json({ success: true });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

io.on('connection', (socket) => {
  socket.on('join', (userId) => {
    socket.join(`user_${userId}`);
  });

  socket.on('send_message', async (data) => {
    const { sender_id, receiver_id, text } = data;
    if (!text || !text.trim()) return;

    const saved = await pool.query(
      'INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1, $2, $3) RETURNING *',
      [sender_id, receiver_id, text.trim()]
    );
    const msg = saved.rows[0];
    io.to(`user_${receiver_id}`).emit('new_message', msg);
    io.to(`user_${sender_id}`).emit('new_message', msg);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
        
