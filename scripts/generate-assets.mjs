import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const iconsDir = path.join(publicDir, 'icons');

fs.mkdirSync(iconsDir, { recursive: true });

function buildIconSvg({ size = 512, maskable = false } = {}) {
  const padding = maskable ? Math.round(size * 0.14) : 0;
  const rx = maskable ? 0 : Math.round(size * 0.16);
  const innerSize = size - padding * 2;
  const cx = size / 2;
  const fontSize = Math.round(innerSize * 0.62);
  const textY = Math.round(padding + innerSize * 0.72);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="0" y="0" width="${size}" height="${size}" rx="${rx}" fill="#146C43"/>
  <text x="${cx}" y="${textY}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="#FFFFFF" text-anchor="middle">P</text>
</svg>`;
}

function buildIcoBuffer(pngEntries) {
  const count = pngEntries.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + count * dirEntrySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirBuffers = [];
  const dataBuffers = [];

  for (const { size, buffer } of pngEntries) {
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += buffer.length;
    dirBuffers.push(entry);
    dataBuffers.push(buffer);
  }

  return Buffer.concat([header, ...dirBuffers, ...dataBuffers]);
}

function buildOgSvg() {
  const cards = [
    { name: 'Bonlieu', info: '652 places · 1,95 m', fill: '#DDF2E7', ink: '#0F5132', bar: '#146C43', w: 145, label: 'Disponible' },
    { name: 'Courier', info: '757 places · 1,95 m', fill: '#DDF2E7', ink: '#0F5132', bar: '#146C43', w: 155, label: 'Disponible' },
    { name: 'Hôtel de Ville', info: '408 places · 1,90 m', fill: '#FBEED7', ink: '#7A4300', bar: '#B56500', w: 85, label: 'Limité' },
    { name: 'De la Poste', info: '303 places · 1,90 m', fill: '#DDF2E7', ink: '#0F5132', bar: '#146C43', w: 120, label: 'Disponible' },
    { name: 'Sainte-Claire', info: '336 places · 1,90 m', fill: '#FBE1DF', ink: '#8E1F1A', bar: '#C22F28', w: 38, label: 'Presque complet' }
  ];

  const cardsXml = cards.map((card, i) => {
    const x = 64 + (i * 218);
    return `
    <rect x="${x}" y="310" width="202" height="196" rx="8" fill="#F2F4F6"/>
    <text x="${x + 18}" y="346" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700" fill="#181D23">${card.name}</text>
    <text x="${x + 18}" y="372" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="#4C5560">${card.info}</text>
    <rect x="${x + 18}" y="400" width="166" height="8" rx="4" fill="#E5E9EE"/>
    <rect x="${x + 18}" y="400" width="${card.w}" height="8" rx="4" fill="${card.bar}"/>
    <rect x="${x + 18}" y="440" width="150" height="34" rx="6" fill="${card.fill}"/>
    <text x="${x + 30}" y="462" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="700" fill="${card.ink}">${card.label}</text>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#FFFFFF"/>

  <rect x="64" y="56" width="44" height="44" rx="8" fill="#146C43"/>
  <text x="86" y="88" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" fill="#FFFFFF" text-anchor="middle">P</text>
  <text x="124" y="86" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700" fill="#181D23">AnnecyPark</text>

  <text x="64" y="176" font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="700" fill="#181D23">Parkings d&#39;Annecy en temps réel</text>
  <text x="64" y="224" font-family="Arial, Helvetica, sans-serif" font-size="25" fill="#4C5560">Places disponibles en direct, prévisions d&#39;affluence et itinéraires</text>
  <rect x="64" y="256" width="120" height="6" rx="3" fill="#146C43"/>

  ${cardsXml}

  <text x="64" y="566" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="#4C5560">Grand Annecy Mobilités · Bonlieu, Courier, Hôtel de Ville, Poste, Sainte-Claire</text>
</svg>`;
}

async function generate() {
  const ogPng = await sharp(Buffer.from(buildOgSvg()))
    .png({ palette: true, quality: 90, compressionLevel: 9 })
    .toBuffer();
  fs.writeFileSync(path.join(publicDir, 'og-image.png'), ogPng);

  const iconTargets = [
    { name: 'favicon-48.png', size: 48, maskable: false },
    { name: 'apple-touch-icon.png', size: 180, maskable: false },
    { name: 'icon-192.png', size: 192, maskable: false },
    { name: 'icon-512.png', size: 512, maskable: false },
    { name: 'icon-maskable-512.png', size: 512, maskable: true }
  ];

  for (const target of iconTargets) {
    const svg = buildIconSvg({ size: target.size, maskable: target.maskable });
    const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
    fs.writeFileSync(path.join(iconsDir, target.name), png);
  }

  const ico32 = await sharp(Buffer.from(buildIconSvg({ size: 32 }))).png({ compressionLevel: 9 }).toBuffer();
  const ico48 = await sharp(Buffer.from(buildIconSvg({ size: 48 }))).png({ compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), buildIcoBuffer([
    { size: 32, buffer: ico32 },
    { size: 48, buffer: ico48 }
  ]));

  const ogMeta = await sharp(ogPng).metadata();
  console.log(`Generated og-image.png: ${ogMeta.width}x${ogMeta.height} (${ogPng.length} bytes)`);
  console.log('Generated icons in public/icons/ and public/favicon.ico');
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
