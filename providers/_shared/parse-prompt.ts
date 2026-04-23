// Парсинг промптов из Promptfoo в нормализованную форму.
// Promptfoo отдаёт prompt как строку: либо plain text, либо
// JSON-сериализованный OpenAI-совместимый chat (массив или объект
// `{messages: [...]}`). Content каждого сообщения — string или массив
// частей ({type: 'text', text} | {type: 'image_url', image_url: {url}}).
//
// Возвращаем унифицированную структуру; провайдер-специфичный мапер потом
// переделывает её в формат своего API (GigaChat: attachments file_id,
// YandexGPT: {role, text}, Yandex Vision: первая картинка отдельно).

export type ChatRole = 'system' | 'user' | 'assistant' | 'function';

export interface ParsedImage {
  base64: string;
  mime: string;
}

export interface ParsedMessage {
  role: ChatRole;
  text: string;
  images: ParsedImage[];
}

export interface ParsedPrompt {
  messages: ParsedMessage[];
}

export function parseChatPrompt(raw: string): ParsedPrompt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { messages: [{ role: 'user', text: raw, images: [] }] };
  }

  const inputs: unknown[] | null = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray((parsed as { messages?: unknown }).messages)
      ? (parsed as { messages: unknown[] }).messages
      : null;

  if (!inputs) {
    return { messages: [{ role: 'user', text: raw, images: [] }] };
  }

  const messages: ParsedMessage[] = [];
  for (const m of inputs) {
    if (!isRecord(m)) continue;
    const role = normalizeRole(m.role);
    const content = m.content;

    if (typeof content === 'string') {
      messages.push({ role, text: content, images: [] });
      continue;
    }

    if (Array.isArray(content)) {
      const texts: string[] = [];
      const images: ParsedImage[] = [];
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          texts.push(part.text);
          continue;
        }
        if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
          const decoded = decodeDataUrl(part.image_url.url);
          if (decoded) images.push(decoded);
        }
      }
      messages.push({ role, text: texts.join('\n\n'), images });
    }
  }
  return { messages };
}

export function hasImages(p: ParsedPrompt): boolean {
  return p.messages.some((m) => m.images.length > 0);
}

export function firstImage(p: ParsedPrompt): ParsedImage | null {
  for (const m of p.messages) {
    if (m.images[0]) return m.images[0];
  }
  return null;
}

function normalizeRole(role: unknown): ChatRole {
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'function') {
    return role;
  }
  return 'user';
}

function decodeDataUrl(url: string): ParsedImage | null {
  const m = /^data:([^;,]+);base64,(.+)$/.exec(url);
  if (!m || !m[1] || !m[2]) return null;
  return { mime: m[1], base64: m[2] };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
