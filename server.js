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
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const GIFTS_CATALOG = [
  { id: 'plush_pepe', name: 'Plush Pepe', emoji: '🐸', price: 500, rarity: 'Legendary NFT' },
  { id: 'durov_cap', name: "Durov's Cap", emoji: '🧢', price: 350, rarity: 'Mythic NFT' },
  { id: 'astral_shard', name: 'Astral Shard', emoji: '💎', price: 250, rarity: 'Rare NFT' },
  { id: 'magic_potion', name: 'Magic Potion', emoji: '🧪', price: 100, rarity: 'Rare Gift' },
  { id: 'golden_star', name: 'Golden Star', emoji: '🌟', price: 50, rarity: 'Common Gift' }
];
const NFT_MARKET = [
  { type: 'username', value: '@durov', price: 1000 },
  { type: 'username', value: '@king', price: 750 },
  { type: 'username', value: '@crypto', price: 600 },
  { type: 'number', value: '+88800000001', price: 1200 },
  { type: 'number', value: '+88877777777', price: 900 }
];

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, tg_id BIGINT UNIQUE NOT NULL, phone VARCHAR(20) UNIQUE NOT NULL,
      first_name VARCHAR(100) DEFAULT 'User', username VARCHAR(50) UNIQUE, bio TEXT DEFAULT '',
      avatar_color VARCHAR(80) DEFAULT 'linear-gradient(135deg,#3b82f6,#8b5cf6)',
      is_verified BOOLEAN DEFAULT FALSE, is_premium BOOLEAN DEFAULT FALSE, is_banned BOOLEAN DEFAULT FALSE,
      stars_balance INT DEFAULT 500, nft_usernames JSONB DEFAULT '[]', nft_numbers JSONB DEFAULT '[]',
      gifts JSONB DEFAULT '[]', created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color VARCHAR(80) DEFAULT 'linear-gradient(135deg,#3b82f6,#8b5cf6)';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nft_usernames JSONB DEFAULT '[]';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nft_numbers JSONB DEFAULT '[]';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS gifts JSONB DEFAULT '[]';
    CREATE TABLE IF NOT EXISTS auth_codes (phone VARCHAR(20) PRIMARY KEY, code VARCHAR(10) NOT NULL, expires_at TIMESTAMP NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY, sender_id INT REFERENCES users(id), receiver_id INT DEFAULT NULL,
      channel_id INT DEFAULT NULL, text TEXT NOT NULL, gift_json JSONB DEFAULT NULL, created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel_id INT DEFAULT NULL;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS gift_json JSONB DEFAULT NULL;
    CREATE TABLE IF NOT EXISTS channels (
      id SERIAL PRIMARY KEY, title VARCHAR(100) NOT NULL, username VARCHAR(50) UNIQUE,
      type VARCHAR(20) DEFAULT 'channel', owner_id INT REFERENCES users(id), is_verified BOOLEAN DEFAULT FALSE
    );
  `);
}
initDB().catch(console.error);
function generatePhone(prefix) {
  let d = '';
  for (let i = 0; i < 10; i++) d += Math.floor(Math.random() * 10);
  return `${prefix}${d}`;
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const res = await pool.query('SELECT * FROM users WHERE tg_id = $1', [chatId]);
  if (res.rows.length > 0) {
    const u = res.rows;
    return bot.sendMessage(chatId, `👋 С возвращением, *${u.first_name}*!\n📱 Номер: \`${u.phone}\`\n⭐️ Баланс: *${u.stars_balance} Stars*`, { parse_mode: 'Markdown' });
  }
  bot.sendMessage(chatId, '🌐 *PrivateGram*\nВыбери регион для номера:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🇺🇸 США (+1)', callback_data: 'reg_+1' }, { text: '🇷🇺 Россия (+7)', callback_data: 'reg_+7' }]] }
  });
});

bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  if (q.data.startsWith('reg_')) {
    const existing = await pool.query('SELECT * FROM users WHERE tg_id = $1', [chatId]);
    if (existing.rows.length > 0) return bot.answerCallbackQuery(q.id, { text: 'Уже есть номер!' });
    const phone = generatePhone(q.data.split('_'));
    await pool.query('INSERT INTO users (tg_id, phone, first_name, stars_balance) VALUES ($1, $2, $3, 500)', [chatId, phone, q.from.first_name || 'User']);
    await bot.editMessageText(`✅ *Готово!*\n📱 Номер: \`${phone}\`\n🎁 Бонус: *500 Stars*`, { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'Markdown' });
  }
});
app.post('/api/auth/send-code', async (req, res) => {
  const cleanPhone = (req.body.phone || '').replace(/[\s\-\(\)]/g, '');
  const userRes = await pool.query('SELECT * FROM users WHERE phone = $1', [cleanPhone]);
  if (userRes.rows.length === 0) return res.status(404).json({ error: 'Номер не найден. Нажми /start в боте!' });
  if (userRes.rows[0].is_banned) return res.status(403).json({ error: 'Аккаунт заблокирован.' });
  const code = Math.floor(10000 + Math.random() * 90000).toString();
  await pool.query(`INSERT INTO auth_codes (phone, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '5 minutes') ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = NOW() + INTERVAL '5 minutes'`, [cleanPhone, code]);
  await bot.sendMessage(userRes.rows[0].tg_id, `🔐 Код входа: *${code}*`, { parse_mode: 'Markdown' });
  res.json({ success: true });
});

app.post('/api/auth/verify-code', async (req, res) => {
  const cleanPhone = (req.body.phone || '').replace(/[\s\-\(\)]/g, '');
  const code = (req.body.code || '').trim();
  const codeRes = await pool.query('SELECT * FROM auth_codes WHERE phone = $1 AND code = $2 AND expires_at > NOW()', [cleanPhone, code]);
  if (codeRes.rows.length === 0) return res.status(400).json({ error: 'Неверный код!' });
  await pool.query('DELETE FROM auth_codes WHERE phone = $1', [cleanPhone]);
  const userRes = await pool.query('SELECT * FROM users WHERE phone = $1', [cleanPhone]);
  res.json({ success: true, user: userRes.rows[0] });
});

app.get('/api/bootstrap/:userId', async (req, res) => {
  const me = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.userId]);
  const users = await pool.query('SELECT id, phone, first_name, username, bio, avatar_color, is_verified, is_premium, nft_usernames, nft_numbers, gifts FROM users WHERE is_banned = FALSE ORDER BY id ASC');
  const channels = await pool.query('SELECT * FROM channels ORDER BY id DESC');
  res.json({ me: me.rows[0], users: users.rows, channels: channels.rows, giftsCatalog: GIFTS_CATALOG, nftMarket: NFT_MARKET });
});
            app.post('/api/profile/update', async (req, res) => {
  const { id, first_name, username, bio } = req.body;
  try {
    const cleanUser = username ? username.replace('@', '').toLowerCase().trim() : null;
    const updated = await pool.query('UPDATE users SET first_name = $1, username = $2, bio = $3 WHERE id = $4 RETURNING *', [first_name, cleanUser || null, bio, id]);
    res.json({ success: true, user: updated.rows });
  } catch (e) { res.status(400).json({ error: 'Юзернейм занят!' }); }
});

app.post('/api/shop/buy-premium', async (req, res) => {
  const { userId } = req.body;
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (uRes.rows.is_premium) return res.status(400).json({ error: 'Уже активен!' });
  if (uRes.rows.stars_balance < 200) return res.status(400).json({ error: 'Нужно 200 ⭐️' });
  const updated = await pool.query('UPDATE users SET stars_balance = stars_balance - 200, is_premium = TRUE WHERE id = $1 RETURNING *', [userId]);
  res.json({ success: true, user: updated.rows });
});

app.post('/api/shop/buy-nft', async (req, res) => {
  const { userId, type, value, price } = req.body;
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = uRes.rows;
  if (user.stars_balance < price) return res.status(400).json({ error: 'Недостаточно Stars!' });
  const col = type === 'username' ? 'nft_usernames' : 'nft_numbers';
  const list = Array.isArray(user[col]) ? user[col] : [];
  if (!list.includes(value)) list.push(value);
  const sql = type === 'username'
    ? 'UPDATE users SET stars_balance = stars_balance - $1, nft_usernames = $2 WHERE id = $3 RETURNING *'
    : 'UPDATE users SET stars_balance = stars_balance - $1, nft_numbers = $2, phone = $4 WHERE id = $3 RETURNING *';
  const params = type === 'username' ? [price, JSON.stringify(list), userId] : [price, JSON.stringify(list), userId, value];
  const updated = await pool.query(sql, params);
  res.json({ success: true, user: updated.rows });
});
app.post('/api/shop/send-gift', async (req, res) => {
  const { senderId, receiverId, giftId } = req.body;
  const gift = GIFTS_CATALOG.find(g => g.id === giftId);
  const sRes = await pool.query('SELECT * FROM users WHERE id = $1', [senderId]);
  if (sRes.rows.stars_balance < gift.price) return res.status(400).json({ error: 'Недостаточно Stars!' });
  await pool.query('UPDATE users SET stars_balance = stars_balance - $1 WHERE id = $2', [gift.price, senderId]);
  const rRes = await pool.query('SELECT * FROM users WHERE id = $1', [receiverId]);
  const gifts = Array.isArray(rRes.rows.gifts) ? rRes.rows.gifts : [];
  const giftEntry = { ...gift, from: sRes.rows.first_name, date: new Date().toISOString() };
  gifts.push(giftEntry);
  await pool.query('UPDATE users SET gifts = $1 WHERE id = $2', [JSON.stringify(gifts), receiverId]);
  const savedMsg = await pool.query('INSERT INTO messages (sender_id, receiver_id, text, gift_json) VALUES ($1, $2, $3, $4) RETURNING *', [senderId, receiverId, `Подарок: ${gift.name}`, JSON.stringify(giftEntry)]);
  io.to(`user_${receiverId}`).emit('new_message', savedMsg.rows);
  io.to(`user_${senderId}`).emit('new_message', savedMsg.rows);
  res.json({ success: true });
});

app.post('/api/channels/create', async (req, res) => {
  const { title, username, ownerId } = req.body;
  try {
    const clean = username ? username.replace('@', '').toLowerCase().trim() : null;
    await pool.query('INSERT INTO channels (title, username, owner_id) VALUES ($1, $2, $3)', [title, clean || null, ownerId]);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: 'Юзернейм занят' }); }
});
app.get('/api/messages/direct/:u1/:u2', async (req, res) => {
  const msgs = await pool.query('SELECT * FROM messages WHERE channel_id IS NULL AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)) ORDER BY created_at ASC', [req.params.u1, req.params.u2]);
  res.json(msgs.rows);
});

app.get('/api/messages/channel/:chId', async (req, res) => {
  const msgs = await pool.query('SELECT m.*, u.first_name as sender_name, u.is_verified as sender_verified FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.channel_id = $1 ORDER BY m.created_at ASC', [req.params.chId]);
  res.json(msgs.rows);
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ success: true, token: ADMIN_PASSWORD });
  else res.status(401).json({ error: 'Неверный пароль' });
});

app.get('/api/admin/data', async (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) return res.status(403).end();
  const users = await pool.query('SELECT * FROM users ORDER BY id ASC');
  const channels = await pool.query('SELECT * FROM channels ORDER BY id ASC');
  res.json({ users: users.rows, channels: channels.rows, gifts: GIFTS_CATALOG });
});
app.post('/api/admin/update-user', async (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) return res.status(403).end();
  const { id, is_verified, is_premium, is_banned, stars_balance, phone, username, add_nft_user, add_nft_num, add_gift_id } = req.body;
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  const u = uRes.rows;
  let nftUsers = Array.isArray(u.nft_usernames) ? u.nft_usernames : [];
  let nftNums = Array.isArray(u.nft_numbers) ? u.nft_numbers : [];
  let gifts = Array.isArray(u.gifts) ? u.gifts : [];
  if (add_nft_user && !nftUsers.includes(add_nft_user)) nftUsers.push(add_nft_user);
  if (add_nft_num && !nftNums.includes(add_nft_num)) nftNums.push(add_nft_num);
  if (add_gift_id) {
    const g = GIFTS_CATALOG.find(item => item.id === add_gift_id);
    if (g) gifts.push({ ...g, from: 'Admin', date: new Date().toISOString() });
  }
  await pool.query('UPDATE users SET is_verified=$1, is_premium=$2, is_banned=$3, stars_balance=$4, phone=$5, username=$6, nft_usernames=$7, nft_numbers=$8, gifts=$9 WHERE id=$10',
    [is_verified, is_premium, is_banned, stars_balance, phone, username || null, JSON.stringify(nftUsers), JSON.stringify(nftNums), JSON.stringify(gifts), id]);
  res.json({ success: true });
});

app.post('/api/admin/verify-channel', async (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) return res.status(403).end();
  await pool.query('UPDATE channels SET is_verified = $1 WHERE id = $2', [req.body.is_verified, req.body.id]);
  res.json({ success: true });
});

app.post('/api/admin/broadcast', async (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) return res.status(403).end();
  const users = await pool.query('SELECT tg_id FROM users');
  let sent = 0;
  for (const u of users.rows) { try { await bot.sendMessage(u.tg_id, `📢 *Сообщение:*\n\n${req.body.text}`, { parse_mode: 'Markdown' }); sent++; } catch (e) {} }
  res.json({ success: true, sent });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

io.on('connection', (socket) => {
  socket.on('join', (userId) => socket.join(`user_${userId}`));
  socket.on('send_message', async (data) => {
    const { sender_id, receiver_id, channel_id, text } = data;
    if (!text || !text.trim()) return;
    if (channel_id) {
      const saved = await pool.query('INSERT INTO messages (sender_id, channel_id, text) VALUES ($1, $2, $3) RETURNING *', [sender_id, channel_id, text.trim()]);
      const u = await pool.query('SELECT first_name, is_verified FROM users WHERE id = $1', [sender_id]);
      io.emit('new_channel_message', { ...saved.rows, sender_name: u.rows.first_name, sender_verified: u.rows.is_verified });
    } else {
      const saved = await pool.query('INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1, $2, $3) RETURNING *', [sender_id, receiver_id, text.trim()]);
      io.to(`user_${receiver_id}`).emit('new_message', saved.rows);
      if (Number(receiver_id) !== Number(sender_id)) io.to(`user_${sender_id}`).emit('new_message', saved.rows);
    }
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Server ready'));
    
