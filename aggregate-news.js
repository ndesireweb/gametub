// api/aggregate-news.js
// ⚠️ Nécessite Node 18+ (fetch global dispo sur Vercel)
export default async function handler(req, res) {
    // Active le CORS pour que le frontend puisse appeler
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        // Sources Reddit (subreddits)
        const subreddits = [
            { id: 'PS5', sub: 'PS5', icon: '🎮' },
            { id: 'XboxSeriesX', sub: 'XboxSeriesX', icon: '🟢' },
            { id: 'NintendoSwitch', sub: 'NintendoSwitch', icon: '🔴' },
            { id: 'PC', sub: 'pcmasterrace', icon: '💻' },
            { id: 'PC', sub: 'pcgaming', icon: '🖥️' },
            { id: 'general', sub: 'gaming', icon: '🎲' },
            { id: 'general', sub: 'Games', icon: '🎮' }
        ];

        // Flux RSS (15 sources gaming)
        const rssFeeds = [
            { name: 'IGN', url: 'https://feeds.feedburner.com/ign/all', icon: '🔥' },
            { name: 'GameSpot', url: 'https://www.gamespot.com/feeds/mashup/', icon: '🎯' },
            { name: 'Polygon', url: 'https://www.polygon.com/rss/index.xml', icon: '🔷' },
            { name: 'Kotaku', url: 'https://kotaku.com/rss', icon: '🟣' },
            { name: 'Eurogamer', url: 'https://www.eurogamer.net/?format=rss', icon: '🌍' },
            { name: 'PC Gamer', url: 'https://www.pcgamer.com/rss/', icon: '🖥️' },
            { name: 'Nintendo Life', url: 'https://www.nintendolife.com/feeds/latest', icon: '🍄' },
            { name: 'Push Square', url: 'https://www.pushsquare.com/feeds/latest', icon: '▫️' },
            { name: 'Pure Xbox', url: 'https://www.purexbox.com/feeds/latest', icon: '❎' },
            { name: 'Rock Paper Shotgun', url: 'https://www.rockpapershotgun.com/feed', icon: '📰' },
            { name: 'VG247', url: 'https://www.vg247.com/feed', icon: '🎮' },
            { name: 'Destructoid', url: 'https://www.destructoid.com/feed/', icon: '💣' },
            { name: 'Siliconera', url: 'https://www.siliconera.com/feed/', icon: '🕹️' },
            { name: 'Gematsu', url: 'https://www.gematsu.com/feed', icon: '🇯🇵' },
            { name: 'DualShockers', url: 'https://www.dualshockers.com/feed/', icon: '🎮' }
        ];

        // Récupération parallèle Reddit + RSS
        const [redditArticles, rssArticles] = await Promise.all([
            fetchReddit(subreddits),
            fetchAllRSS(rssFeeds)
        ]);

        // Fusion et dédoublonnage
        const all = [...redditArticles, ...rssArticles];
        const uniqueArticles = deduplicate(all);

        // Tri par date décroissante (récents d'abord)
        uniqueArticles.sort((a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0));

        res.status(200).json({ articles: uniqueArticles });
    } catch (err) {
        res.status(500).json({ error: 'Erreur lors de l’agrégation', details: err.message });
    }
}

// --- Fonctions utilitaires ---

async function fetchReddit(subreddits) {
    const promises = subreddits.map(async ({ id, sub, icon }) => {
        try {
            const url = `https://www.reddit.com/r/${sub}/hot.json?limit=25&raw_json=1`;
            const response = await fetch(url, {
                headers: { 'User-Agent': 'GameNewsAggregator/2.0' }
            });
            if (!response.ok) return [];
            const json = await response.json();
            return json.data.children.map(c => {
                const p = c.data;
                return {
                    title: p.title,
                    url: `https://www.reddit.com${p.permalink}`,
                    score: p.score,
                    comments: p.num_comments,
                    thumbnail: p.thumbnail && p.thumbnail.startsWith('http') ? p.thumbnail : null,
                    sourceName: `r/${sub}`,
                    sourceIcon: icon,
                    categoryId: id,
                    date: new Date(p.created_utc * 1000).toISOString()
                };
            });
        } catch (e) {
            console.error(`Reddit r/${sub} error:`, e.message);
            return [];
        }
    });
    const results = await Promise.all(promises);
    return results.flat();
}

async function fetchAllRSS(feeds) {
    const promises = feeds.map(async ({ name, url, icon }) => {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'GameNewsAggregator/2.0' }
            });
            if (!res.ok) return [];
            const xmlText = await res.text();
            const items = parseRSSItems(xmlText);
            return items.map(item => ({
                title: item.title,
                url: item.link,
                score: 0,
                comments: 0,
                thumbnail: item.thumbnail || null,
                sourceName: name,
                sourceIcon: icon,
                categoryId: guessCategoryFromTitle(item.title, name),
                date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString()
            }));
        } catch (e) {
            console.error(`RSS ${name} error:`, e.message);
            return [];
        }
    });
    const results = await Promise.all(promises);
    return results.flat();
}

// Parser XML minimal pour les flux RSS (sans dépendance)
function parseRSSItems(xml) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
        const itemXml = match[1];
        const title = extractTag(itemXml, 'title');
        const link = extractTag(itemXml, 'link');
        const pubDate = extractTag(itemXml, 'pubDate');
        let thumbnail = null;
        // media:content
        const mediaMatch = itemXml.match(/<media:content[^>]+url="([^"]*)"/i);
        if (mediaMatch) thumbnail = mediaMatch[1];
        else {
            const enclosureMatch = itemXml.match(/<enclosure[^>]+url="([^"]*)"/i);
            if (enclosureMatch) thumbnail = enclosureMatch[1];
        }
        if (title && link) {
            items.push({ title: decodeHTML(title), link, pubDate, thumbnail });
        }
    }
    return items;
}

function extractTag(xml, tag) {
    const regex = new RegExp(`<${tag}[^>]*>(.*?)<\/${tag}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
}

function decodeHTML(html) {
    return html.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
               .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function guessCategoryFromTitle(title, sourceName) {
    const lower = title.toLowerCase();
    if (/ps5|playstation|dualsense|ps plus/i.test(lower)) return 'PS5';
    if (/xbox|series x|game pass|xcloud/i.test(lower)) return 'XboxSeriesX';
    if (/nintendo|switch|mario|zelda|pokémon|pokemon/i.test(lower)) return 'NintendoSwitch';
    if (/pc|steam|epic games|gog/i.test(lower)) return 'PC';
    return 'general';
}

function deduplicate(articles) {
    const seen = new Set();
    return articles.filter(art => {
        const norm = normalizeTitle(art.title);
        if (seen.has(norm)) return false;
        seen.add(norm);
        return true;
    });
}

function normalizeTitle(title) {
    return title.toLowerCase().replace(/[^a-z0-9à-ü]/g, '').trim().substring(0, 60);
}