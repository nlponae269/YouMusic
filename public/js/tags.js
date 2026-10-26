// Чтение ID3v2-тегов прямо в браузере: название, артист, альбом, обложка, текст песни.

function synchsafe(b, o) {
  return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
}

function decodeText(bytes, enc) {
  const label = ['latin1', 'utf-16', 'utf-16be', 'utf-8'][enc] || 'latin1';
  return new TextDecoder(label).decode(bytes).replace(/\0+$/, '').trim();
}

// Конец строки, оканчивающейся нулём (для UTF-16 — двойным нулём на чётной позиции)
function strEnd(b, start, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return [i, i + 2];
  } else {
    for (let i = start; i < b.length; i++) if (b[i] === 0) return [i, i + 1];
  }
  return [b.length, b.length];
}

export async function readTags(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
  const version = head[3];
  const size = synchsafe(head, 6);
  const b = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
  let pos = 0;
  if (head[5] & 0x40) pos += version === 4 ? synchsafe(b, 0) : ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) + 4;
  const tags = {};
  while (pos + 10 < b.length) {
    const id = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = version === 4 ? synchsafe(b, pos + 4) : (b[pos + 4] << 24) | (b[pos + 5] << 16) | (b[pos + 6] << 8) | b[pos + 7];
    const data = b.subarray(pos + 10, pos + 10 + len);
    pos += 10 + len;
    if (!len) continue;
    const enc = data[0];
    try {
      if (id === 'TIT2') tags.title = decodeText(data.subarray(1), enc);
      else if (id === 'TPE1') tags.artist = decodeText(data.subarray(1), enc).replace(/\0/g, ', ');
      else if (id === 'TALB') tags.album = decodeText(data.subarray(1), enc);
      else if (id === 'USLT') {
        const [, next] = strEnd(data, 4, enc);
        tags.lyrics = decodeText(data.subarray(next), enc);
      } else if (id === 'APIC' && !tags.cover) {
        const [mimeEnd, afterMime] = strEnd(data, 1, 0);
        let mime = new TextDecoder('latin1').decode(data.subarray(1, mimeEnd)).toLowerCase();
        if (!mime.includes('/')) mime = `image/${mime === 'png' ? 'png' : 'jpeg'}`;
        if (mime === 'image/jpg') mime = 'image/jpeg';
        const [, picStart] = strEnd(data, afterMime + 1, enc);
        tags.cover = new File([data.slice(picStart)], 'cover', { type: mime });
      }
    } catch { /* битый фрейм — пропускаем */ }
  }
  return tags;
}

