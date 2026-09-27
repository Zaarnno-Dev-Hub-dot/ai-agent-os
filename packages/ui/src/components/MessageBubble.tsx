import { useMemo, useState } from 'react';
import { Message } from '@agent-os/shared';
import { useStore } from '../store/gatewayStore';
import { useVoiceStore } from '../store/voiceStore';
import { isTTSSupported } from '../lib/voice';
import { renderMarkdown } from '../lib/markdown';
import { highlightMentionsHtml } from '../lib/mentions';
import { AttachmentView } from './Attachment';
import { EmojiPicker } from './EmojiPicker';

export function MessageBubble({ message }: { message: Message }) {
  const { agents, sendClientEvent } = useStore();
  const speakingMessageId = useVoiceStore((s) => s.speakingMessageId);
  const playMessage = useVoiceStore((s) => s.playMessage);
  const stopSpeaking = useVoiceStore((s) => s.stopSpeaking);
  const [reactOpen, setReactOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  // Feature-detect, not memoized — cheap (typeof check) and support can't
  // change mid-session, but re-evaluating avoids any staleness concern.
  const ttsSupported = isTTSSupported();
  const isSpeakingThis = speakingMessageId === message.id;

  const isHuman = message.senderId === 'human';
  const agent = agents.find((a) => a.id === message.senderId);
  const senderName = isHuman ? 'You' : agent?.displayName ?? message.senderId;
  const senderColor = isHuman ? 'var(--txt)' : agent?.color ?? 'var(--accent-gold)';

  const knownIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);
  const html = useMemo(() => {
    const rendered = renderMarkdown(message.content);
    return highlightMentionsHtml(rendered, knownIds);
  }, [message.content, knownIds]);

  const canEdit = isHuman; // human can edit their own messages; agent messages are append-only from UI

  function toggleReaction(emoji: string) {
    sendClientEvent({ type: 'chat.react', payload: { messageId: message.id, emoji } });
    setReactOpen(false);
  }

  function saveEdit() {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== message.content) {
      sendClientEvent({ type: 'chat.edit', payload: { messageId: message.id, content: trimmed } });
    }
    setEditing(false);
  }

  function handleDelete() {
    sendClientEvent({ type: 'chat.delete', payload: { messageId: message.id } });
  }

  return (
    <div className="msg">
      <div
        className="av"
        style={{
          width: 38,
          height: 38,
          fontSize: 16,
          background: isHuman ? 'rgba(30,122,87,.25)' : `${agent?.color ?? '#c9a35c'}33`,
        }}
      >
        {isHuman ? '☺' : agent?.avatar ?? '☤'}
      </div>
      <div className="body">
        <div className="hdr">
          <span className="name" style={{ color: senderColor }}>
            {senderName}
          </span>
          {!isHuman && agent && (
            <span className="harness">
              {agent.harness} · {agent.flavor}
            </span>
          )}
          {message.verifyBadge === 'verify-outputs' && (
            <span className="verify" title="This harness's outputs are unverified — review before trusting">
              ⚠ verify outputs
            </span>
          )}
          <span className="time">
            {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {message.updatedAt && <span className="time edited-tag">(edited)</span>}
          <span className="msg-actions">
            <button className="msg-action-btn" title="React" data-emoji-trigger onClick={() => setReactOpen((v) => !v)}>
              😊
            </button>
            {canEdit && !editing && (
              <button className="msg-action-btn" title="Edit" onClick={() => setEditing(true)}>
                ✎
              </button>
            )}
            {canEdit && (
              <button className="msg-action-btn" title="Delete" onClick={handleDelete}>
                🗑
              </button>
            )}
            {ttsSupported && (
              <button
                className="msg-action-btn"
                title={isSpeakingThis ? 'Stop reading' : 'Read aloud'}
                onClick={() => (isSpeakingThis ? stopSpeaking() : playMessage(message.id, message.content))}
              >
                {isSpeakingThis ? '⏹' : '🔊'}
              </button>
            )}
          </span>
          {reactOpen && <EmojiPicker onPick={toggleReaction} onClose={() => setReactOpen(false)} />}
        </div>

        {editing ? (
          <div className="edit-box">
            <textarea
              className="edit-textarea"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                }
                if (e.key === 'Escape') {
                  setEditing(false);
                  setEditValue(message.content);
                }
              }}
              autoFocus
            />
            <div className="edit-actions">
              <button className="cbtn" onClick={() => { setEditing(false); setEditValue(message.content); }}>
                Cancel
              </button>
              <button className="send" onClick={saveEdit}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
        )}

        {message.attachments?.map((a) => <AttachmentView key={a.id} attachment={a} />)}

        {message.reactions && message.reactions.length > 0 && (
          <div className="reacts">
            {message.reactions.map((r) => (
              <span
                key={r.emoji}
                className={`react ${r.userIds.includes('human') ? 'me' : ''}`}
                onClick={() => toggleReaction(r.emoji)}
                title={r.userIds.join(', ')}
              >
                {r.emoji} {r.userIds.length}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
