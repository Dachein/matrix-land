import { View } from '@tarojs/components';
import { memo } from 'react';
import { MateAvatar } from './Avatar';
import { MessageParts, type ApprovalHandler, type PartOpenHandler } from './MessageParts';
import { TypingIndicator } from './TypingIndicator';
import { useI18n } from '../services/i18n';
import type { ChatMessage, LiveSession, RuntimeApproval } from '../types';

// Input changes and keyboard events do not need to reconcile settled message trees.
export const ChatMessageRow = memo(function ChatMessageRow({ message, active, recovering, session, avatarUrl, approvals, onApproval, onOpen }: {
  message: ChatMessage; active: boolean; recovering: boolean; session?: LiveSession;
  avatarUrl?: string; approvals: RuntimeApproval[]; onApproval: ApprovalHandler; onOpen: PartOpenHandler;
}) {
  const { t } = useI18n();
  return <View id={`message-${message.id}`} className={`message-row ${message.role}`}>
    {message.role === 'assistant' && active && <MateAvatar avatarUrl={avatarUrl} className="message-avatar" motion={active ? recovering ? 'waiting' : 'running' : 'idle'} />}
    <View className="message-body">
      <MessageParts session={session} active={active} message={message} onApproval={onApproval} onOpen={onOpen} approvals={approvals} />
      {active && <TypingIndicator inline label={recovering ? t('chat.recovering') : ''} />}
    </View>
  </View>;
});
