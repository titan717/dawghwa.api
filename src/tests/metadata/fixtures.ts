export const AL_SOLO = {
  id: 105398,
  idMal: 121496,
  title: { romaji: "Na Honjaman Level Up", english: "Solo Leveling", native: "나 혼자만 레벨업" },
  synonyms: ["I Level Up Alone", "Only I Level Up"],
  format: "MANGA",
  status: "FINISHED",
  countryOfOrigin: "KR",
  startDate: { year: 2018 },
  chapters: 201,
  volumes: 14,
  genres: ["Action", "Adventure", "Fantasy"],
  averageScore: 84,
  meanScore: 85,
  popularity: 200000,
  coverImage: { extraLarge: "https://s4.anilist.co/cover.jpg", large: null },
  bannerImage: null,
  isAdult: false,
  siteUrl: "https://anilist.co/manga/105398",
  updatedAt: 1700000000,
  description: "10 years ago, after <i>the Gate</i>...<br>",
  tags: [{ name: "Dungeon", rank: 90, isMediaSpoiler: false, category: "Setting" }],
  staff: { edges: [{ role: "Story", node: { name: { full: "Chugong" } } }, { role: "Art", node: { name: { full: "DUBU" } } }] },
  externalLinks: [{ site: "Webtoon", url: "https://www.webtoons.com/x", type: "STREAMING" }],
};

export const MU_SOLO = {
  series_id: 15180124327,
  title: "Solo Leveling",
  url: "https://www.mangaupdates.com/series/6z1uqw7/solo-leveling",
  associated: [{ title: "Na Honjaman Level Up" }, { title: "Solo Leveling" }],
  description: "A <b>weak</b> hunter",
  image: { url: { original: "https://cdn.mangaupdates.com/image/i515366.jpg" } },
  type: "Manhwa",
  year: "2018",
  bayesian_rating: 8.53,
  genres: [{ genre: "Action" }, { genre: "Fantasy" }],
  latest_chapter: 200,
  status: "200 Chapters (Complete)",
  completed: true,
  categories: [{ category: "Dungeons", votes: 30 }],
  authors: [{ name: "Chugong", type: "Author" }, { name: "DUBU", type: "Artist" }],
  last_updated: { timestamp: 1700000000 },
};

export const MD_SOLO_ID = "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0";

export function mdSearchHit(id: string, title: string, lastChapter = "200") {
  return {
    id,
    type: "manga",
    attributes: { title: { en: title }, altTitles: [], lastChapter, updatedAt: "2024-01-01T00:00:00Z", tags: [] },
    relationships: [{ id: "c", type: "cover_art", attributes: { fileName: "cover.jpg" } }],
  };
}
