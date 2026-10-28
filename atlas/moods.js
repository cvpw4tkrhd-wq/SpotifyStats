// Mood themes and the tag -> mood mapping.
// Spotify no longer provides audio features (energy, valence...) to new apps,
// so each artist's mood is estimated from its Last.fm tags.
// This is a heuristic: edit the tag lists below to fit your own taste.

export const MOODS = {
  chill: {
    label: 'Chill', color: '#2dd4bf', color2: '#38bdf8',
    tags: ['chill', 'chillout', 'chill-out', 'ambient', 'downtempo', 'lo-fi', 'lofi', 'relaxing', 'relax',
      'mellow', 'easy listening', 'acoustic', 'singer-songwriter', 'folk', 'soft', 'dream pop', 'trip-hop',
      'bossa nova', 'new age', 'calm', 'smooth', 'soft rock', 'indie folk', 'chillwave', 'lounge',
      'atmospheric', 'dreamy', 'ethereal'],
  },
  energetic: {
    label: 'Energetic', color: '#f97316', color2: '#ef4444',
    tags: ['rock', 'hard rock', 'metal', 'heavy metal', 'punk', 'punk rock', 'pop punk', 'hardcore',
      'drum and bass', 'techno', 'trance', 'thrash metal', 'energetic', 'workout', 'alternative rock',
      'power metal', 'metalcore', 'post-hardcore', 'grunge', 'garage rock', 'hardstyle', 'electro',
      'dubstep', 'progressive metal', 'death metal', 'speed metal', 'hard techno'],
  },
  happy: {
    label: 'Happy', color: '#facc15', color2: '#a3e635',
    tags: ['happy', 'feel good', 'feel-good', 'pop', 'disco', 'funk', 'summer', 'upbeat', 'reggae',
      'dance-pop', 'dance pop', 'ska', 'swing', 'schlager', 'eurodance', 'synthpop', 'synth-pop',
      'indie pop', 'power pop', 'k-pop', 'j-pop', 'cheerful', 'fun', 'country'],
  },
  melancholic: {
    label: 'Melancholic', color: '#4f7cff', color2: '#818cf8',
    tags: ['sad', 'melancholy', 'melancholic', 'emo', 'depressive', 'blues', 'sadcore', 'slowcore',
      'ballad', 'depressing', 'heartbreak', 'shoegaze', 'indie', 'bittersweet', 'nostalgic', 'nostalgia',
      'indie rock', 'alternative'],
  },
  dark: {
    label: 'Dark', color: '#9333ea', color2: '#4c1d95',
    tags: ['dark', 'gothic', 'goth', 'gothic rock', 'industrial', 'darkwave', 'black metal', 'doom metal',
      'doom', 'post-punk', 'noir', 'dark ambient', 'ebm', 'cold wave', 'witch house', 'horror', 'deathrock'],
  },
  romantic: {
    label: 'Romantic', color: '#fb7185', color2: '#f43f5e',
    tags: ['love', 'romantic', 'r&b', 'rnb', 'soul', 'love songs', 'smooth jazz', 'neo-soul',
      'quiet storm', 'slow jam', 'sensual', 'sexy', 'adult contemporary'],
  },
  party: {
    label: 'Party', color: '#f0abfc', color2: '#ec4899',
    tags: ['party', 'dance', 'edm', 'electronic', 'club', 'hip-hop', 'hip hop', 'rap', 'trap', 'reggaeton',
      'house', 'electro house', 'deep house', 'big room', 'latin', 'dancehall', 'afrobeats', 'bass',
      'tech house', 'progressive house', 'uk garage', 'grime', 'gangsta rap'],
  },
  focus: {
    label: 'Focus', color: '#e2e8f0', color2: '#94a3b8',
    tags: ['instrumental', 'classical', 'jazz', 'soundtrack', 'score', 'post-rock', 'piano', 'minimal',
      'study', 'ost', 'film score', 'orchestral', 'neoclassical', 'modern classical',
      'contemporary classical', 'baroque', 'cinematic', 'math rock', 'minimalism', 'video game music'],
  },
};

const TAG2MOOD = {};
for (const [key, m] of Object.entries(MOODS)) {
  for (const t of m.tags) (TAG2MOOD[t] ||= []).push(key);
}

// Tags that describe something other than a genre
const BLOCK = new Set([
  'seen live', 'favorites', 'favourites', 'favorite', 'favourite', 'awesome', 'beautiful', 'good', 'best',
  'love', 'loved', 'my music', 'spotify', 'all', 'female vocalists', 'female vocalist', 'male vocalists',
  'male vocalist', 'vocalists', 'swedish', 'sweden', 'american', 'british', 'english', 'usa', 'uk',
  'norwegian', 'danish', 'german', 'french', 'finnish', 'canadian', 'australian', 'icelandic', 'japanese',
  'korean', 'italian', 'spanish', 'brazilian', 'under 2000 listeners', 'albums i own', 'guilty pleasure',
  'legend', 'classic', 'cool', 'epic', 'amazing', 'perfect', 'masterpiece', 'singer', 'band', 'duo',
]);

const ALIAS = {
  'hip hop': 'hip-hop', 'rnb': 'r&b', 'rhythm and blues': 'r&b', 'drum n bass': 'drum and bass',
  'dnb': 'drum and bass', 'electronica': 'electronic', 'synthpop': 'synth-pop',
};

// tags: [[name, count], ...]  ->  { mood: share } or null if no tag matched
export function moodVector(tags) {
  const v = {};
  let sum = 0;
  for (const [name, count] of tags) {
    const ms = TAG2MOOD[String(name).toLowerCase()];
    if (!ms) continue;
    for (const m of ms) {
      v[m] = (v[m] || 0) + count / ms.length;
      sum += count / ms.length;
    }
  }
  if (!sum) return null;
  for (const m in v) v[m] /= sum;
  return v;
}

const title = (s) => (s === 'r&b' ? 'R&B' : s.replace(/(^|[\s-])([a-z])/g, (_, a, b) => a + b.toUpperCase()));

// First tag that looks like a genre
export function primaryGenre(tags) {
  for (const [name] of tags) {
    let g = String(name).toLowerCase().trim();
    if (BLOCK.has(g) || /^\d{2,4}s?$/.test(g)) continue;
    g = ALIAS[g] || g;
    return title(g);
  }
  return null;
}

// Up to n distinct genre-like tags, title-cased (used for the chips on artist pages)
export function topGenres(tags, n = 4) {
  const out = [];
  for (const [name] of tags) {
    let g = String(name).toLowerCase().trim();
    if (BLOCK.has(g) || /^\d{2,4}s?$/.test(g)) continue;
    g = title(ALIAS[g] || g);
    if (!out.includes(g)) out.push(g);
    if (out.length >= n) break;
  }
  return out;
}
