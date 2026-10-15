// Document preparation shared by the Application/Bar and Desktop assistants.
// The caller owns conversation storage, UI notices and localized phrasing.
import { projectDocIds, projectServedInFull } from './projects.js';

export async function collectDocumentContext({ query, documents = [], project = null, ragMode = false, search, fullChars = 12000, labels = {} }) {
  const parts = [];
  const projectIds = project && !projectServedInFull(project) ? projectDocIds(project) : [];
  const ragDocuments = documents.filter(doc => doc.mode === 'rag' && doc.docId);
  const ids = [...new Set([...ragDocuments.map(doc => doc.docId), ...projectIds])];
  for (const doc of documents) {
    if (doc.mode !== 'full' || doc.injected) continue;
    doc.injected = true;
    parts.push(`--- ${doc.name} ---\n${doc.text}`);
  }
  let hits = [], failure = '', status = '';
  if ((ragMode || ids.length) && String(query || '').trim()) {
    try { hits = await search({ query, k: 8, docIds: ragMode ? null : ids }) || []; }
    catch (error) { failure = String(error?.message || error); }
    if (hits.length) {
      const extracts = hits.map((hit, index) => `[${index + 1}] (${hit.title}) ${String(hit.text || '').trim()}`).join('\n\n');
      parts.push(`${labels.extracts || ''}\n${extracts}\n\n${labels.cite || ''}`);
      status = 'found';
    } else {
      let fallback = false;
      for (const doc of ragDocuments) {
        if (doc.injected || !doc.text) continue;
        doc.injected = true; fallback = true;
        const head = doc.text.slice(0, fullChars);
        parts.push(`--- ${doc.name} ---\n${head}${doc.text.length > head.length ? `\n${labels.truncated || ''}` : ''}`);
      }
      status = fallback ? 'fallback' : failure ? 'failed' : ragMode ? 'empty' : projectIds.length ? 'project-empty' : 'empty';
    }
  }
  return { parts, hits, failure, status };
}
