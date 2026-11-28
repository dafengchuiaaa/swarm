import { OWNER, type TeamService } from '../../../swarm-team/src/service';
import type { SwarmStore } from './store';

export function buildPublicBoard(store: SwarmStore, team: TeamService, input: {
  projectId: string;
  sessionId?: string;
}) {
  const project = store.project(input.projectId);
  if (!project) throw new Error('项目不存在');
  const sessions = store.listSessions(input.projectId).filter(s => !store.isHandoffSuccessor(s.id));
  const sessionMap = new Map(sessions.map(s => [s.id, s]));
  const channels = project.kind === 'inbox' && !input.sessionId ? [] : team.channels(input.projectId, input.sessionId);
  const publicChannels = channels.filter(c => c.kind === 'channel' && !c.archived);
  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
  const rawMap = new Map<string, { senderLabel: string; preview: string }>();
  const messages: Array<{
    id: string;
    channelName: string;
    sender: string;
    senderLabel: string;
    host: string;
    model: string;
    toLabel: string;
    text: string;
    time: string;
    threadId?: string;
    replyToLabel?: string;
    replyPreview?: string;
    hint?: string;
  }> = [];
  for (const ch of publicChannels) {
    const view = team.view(input.projectId, OWNER, ch.id, input.sessionId);
    for (const root of view.roots) {
      rawMap.set(root.id, { senderLabel: root.senderLabel, preview: clip(root.text.replace(/\s+/g, ' '), 36) });
      const rootSess = sessionMap.get(root.sender);
      messages.push({
        id: root.id,
        channelName: ch.name,
        sender: root.sender,
        senderLabel: root.senderLabel,
        host: rootSess?.host ?? '',
        model: rootSess?.model ?? '',
        toLabel: root.toLabel,
        text: clip(root.text, 400),
        time: root.time,
        hint: root.dispatch ? `派工给 @${root.toLabel} · ${root.dispatch.status}` : root.to !== 'all' ? `@${root.toLabel}` : undefined,
      });
      for (const reply of view.replies[root.id] ?? []) {
        rawMap.set(reply.id, { senderLabel: reply.senderLabel, preview: clip(reply.text.replace(/\s+/g, ' '), 36) });
        const replySess = sessionMap.get(reply.sender);
        messages.push({
          id: reply.id,
          channelName: ch.name,
          sender: reply.sender,
          senderLabel: reply.senderLabel,
          host: replySess?.host ?? '',
          model: replySess?.model ?? '',
          toLabel: reply.toLabel,
          text: clip(reply.text, 400),
          time: reply.time,
          threadId: root.id,
          hint: reply.dispatch ? `派工回话 · ${reply.dispatch.status}` : undefined,
        });
      }
    }
  }
  for (const msg of messages) {
    if (msg.threadId) {
      const parent = rawMap.get(msg.threadId);
      if (parent) {
        msg.replyToLabel = parent.senderLabel;
        msg.replyPreview = parent.preview;
      }
    }
  }
  messages.sort((a, b) => a.time.localeCompare(b.time));
  return {
    stallMonitorEnabled: store.getStallMonitorEnabled(),
    messages: messages.slice(-60),
  };
}
