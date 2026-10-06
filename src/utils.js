export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

export const pick = (items) => items[Math.floor(Math.random() * items.length)];

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const clean = (value) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value == null ? '' : String(value).trim();

export function envInt(name, fallback) {
  const raw = process.env[name];
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const envBool = (name, fallback = false) =>
  process.env[name] == null ? fallback : /^(1|true|yes)$/i.test(process.env[name]);

const stamp = () => new Date().toISOString();
export const log = {
  info: (...args) => console.log(stamp(), 'INFO ', ...args),
  warn: (...args) => console.warn(stamp(), 'WARN ', ...args),
  error: (...args) => console.error(stamp(), 'ERROR', ...args),
};
