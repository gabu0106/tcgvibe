// 共通セキュリティヘルパー

const ALLOWED_ORIGINS = ['https://tcgvibe.com', 'https://www.tcgvibe.com'];

// CORS: tcgvibe.comのみ許可（開発時はlocalhost）
export function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || origin.includes('localhost') || origin.includes('127.0.0.1')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

// 内部APIキー認証（GitHub Actions/cron用）
export function requireInternalKey(req, res) {
  const key = req.headers['x-api-key'] || req.body?.api_key;
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    res.status(401).json({ error: 'Unauthorized: invalid API key' });
    return false;
  }
  return true;
}

// 管理者キー認証
export function requireAdminKey(req, res) {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (!key || key !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// XSS対策: HTMLエスケープ
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
