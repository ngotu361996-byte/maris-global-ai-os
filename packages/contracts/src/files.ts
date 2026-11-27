export const FILE_KINDS = ['image', 'text', 'document', 'video', 'audio'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  image: 'Hình ảnh',
  text: 'Văn bản',
  document: 'Tài liệu',
  video: 'Video',
  audio: 'Âm thanh',
};

/** What the AI can use today. Other kinds are stored, and AI reading for them comes later. */
export const FILE_AI_READS: Record<FileKind, boolean> = {
  image: true,
  text: true,
  document: false,
  video: false,
  audio: false,
};

/** File types MARIS accepts, shown in the upload picker. The server checks the content itself. */
export const FILE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json,.pdf,.docx,.xlsx,.pptx,.mp4,.mov,.webm,.mp3,.m4a,.wav,.ogg';

/** At most this many files on one chat message. */
export const MAX_ATTACHMENTS = 8;

export interface FileResponse {
  id: string;
  name: string;
  mime: string;
  kind: FileKind;
  sizeBytes: number;
  conversationId: string | null;
  messageId: string | null;
  createdAt: string;
}

export interface AttachmentRef {
  id: string;
  name: string;
  kind: FileKind;
  mime: string;
  sizeBytes: number;
}
