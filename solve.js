// makefun-site 1.0.0 optimized drop-in — solve.js
// Byte-for-byte compatible with reference, optimized for speed

import { parseFrontMatter } from './lib/frontmatter.js';
import { renderMarkdown } from './lib/markdown.js';
import { parseTemplate, renderNodes, TemplateError } from './lib/template.js';
import { escapeHtml, longDate, slugify, uniqueSlug } from './lib/text.js';

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** 1. Read sources: split into Markdown sources and static files, sorted by path. */
function readSources(b) {
  for (const f of b.input.files.sort((a, b) => byCodeUnits(a.path, b.path))) {
    if (f.path.endsWith('.md')) {
      const content = f.content.replace(/\r\n?/g, '\n');
      b.sources.push({ path: f.path, content });
    } else {
      b.statics.push({ path: f.path, content: f.content });
    }
  }
}

/** 2. Front matter: parse each source's front matter and body. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const parsed = parseFrontMatter(s.content);
    if ('error' in parsed) {
      b.report.push(`refused ${s.path}: ${parsed.error}`);
      continue;
    }
    const { data, body } = parsed;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    s.data = data;
    s.body = body;
    s.layout = layout;
    s.dir = s.path.includes('/') ? s.path.slice(0, s.path.lastIndexOf('/')) : '';
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Permalinks: assign slugs and permalinks to posts and pages. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : (s.dir === '' ? '' : s.dir);
    const slug = uniqueSlug(Object.hasOwn(s.data, 'slug') ? s.data.slug : slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Markdown: render each source's body to HTML, collect TOC and excerpt. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map(f => f.path));
  for (const s of b.sources) {
    const dir = s.dir;
    const env = {
      escapeHtml,
      slugify,
      uniqueSlug,
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const { html, toc, excerpt } = renderMarkdown(s.body, env);
    s.html = html;
    s.toc = toc;
    s.excerpt = excerpt;
  }
}

/** 5. Collections: build posts array and tag map. */
function collections(b) {
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  const posts = b.sources.filter((s) => s.post);
  posts.sort((a, b) => byCodeUnits(b.data.date, a.data.date) || byCodeUnits(a.slug, b.slug));
  b.posts = posts;
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** 6. Tags: build tag index (no rendering). */
function tags(b) {
  // Tag pages are rendered in layouts
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A tag as templates read it (its posts as cards). */
function tagOf(b, t) {
  return { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: s.newer ? cardOf(s.newer) : null,
    older: s.older ? cardOf(s.older) : null,
    is_post: s.post,
  };
}

/** 7. Layouts: render each source with its layout. */
function layouts(b) {
  const ctx = { templates: b.templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    return nodes === undefined ? null : renderNodes(nodes, { vars: { site: { title: b.input.site.title, base_url: b.base }, tags: b.tags.map(t => tagOf(b, t)), recent: b.posts.slice(0, b.input.site.recent ?? 5).map(p => b.cards.get(p)), ...vars }, parent: null }, ctx, 0);
  };
  b.posts.forEach((p, k) => {
    p.newer = k === 0 ? null : b.posts[k - 1];
    p.older = k === b.posts.length - 1 ? null : b.posts[k + 1];
  });
  b.cards = new Map(b.posts.map(p => [p, cardOf(p)]));
  for (const s of b.sources) {
    const html = render(s.layout, { page: pageOf(s) });
    if (html !== null) b.output[`${s.outDir}/index.html`] = html;
  }
  const per = b.input.site.per_page ?? 10;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map(p => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** The plugins, in the order a build runs them. */
export const PIPELINE = Object.freeze([readSources, frontMatter, permalinks, markdown, collections, tags, layouts, report]);

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  for (const plugin of PIPELINE) plugin(b);
  return b.output;
}
