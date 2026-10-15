// Stable sidebar groups; neither reads nor merges conversation stores/profiles.
export function conversationGroups(conversations, folders, { pinned = 'Épinglés', recent = 'Discussions récentes' } = {}) {
  const known = new Map(folders.map(folder => [folder.id, folder]));
  const groups = new Map();
  const add = (id, label, conversation, kind) => {
    if (!groups.has(id)) groups.set(id, { id, label, kind, conversations: [] });
    groups.get(id).conversations.push(conversation);
  };
  for (const conversation of conversations) {
    if (conversation.pinned) add('pinned', pinned, conversation, 'pinned');
    else {
      const folder = known.get(conversation.folder);
      if (folder) add(`project:${folder.id}`, folder.name, conversation, 'project');
      else add('recent', recent, conversation, 'recent');
    }
  }
  return [...groups.values()].sort((a, b) => {
    const rank = group => group.kind === 'pinned' ? 0 : group.kind === 'project' ? 1 : 2;
    return rank(a) - rank(b);
  });
}
