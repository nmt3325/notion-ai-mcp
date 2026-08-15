export interface AccountContext { tokenV2:string; userId:string; userName:string; userEmail:string; spaceId:string; spaceName:string; spaceViewId:string; timezone:string; clientVersion:string; browserId:string; deviceId:string; fullCookie?:string; pinnedSpaceId?:string }
export interface WorkspaceInfo { spaceId:string; spaceViewId:string; spaceName:string; plan:string; createdTime:number|null }
export interface ConversationSummary { id:string; title:string; type:string; createdAt:number|null; updatedAt:number|null; messageCount:number; unread:boolean }
export interface ConversationMessage { id:string; role:"user"|"assistant"; text:string; createdAt:number|null }
export interface Conversation { id:string; title:string; type:string; createdAt:number|null; updatedAt:number|null; messages:ConversationMessage[] }
export interface ListConversationsResult { conversations:ConversationSummary[]; nextCursor:string|null; hasMore:boolean }
export interface ChatResult { conversationId:string; text:string; model:string; reasoningEffort?:string|undefined; usage:{inputTokens:number;outputTokens:number} }
export interface ChatSession { threadId:string; configId:string; contextId:string; originalDatetime:string; model:string; reasoningEffort?:string|undefined; updatedConfigIds:string[]; turnCount:number; transport?:"inference_transcript"|"agent_service"; rehydrated?:boolean|undefined }
export interface ParsedInferenceStream { text:string; inputTokens:number; outputTokens:number; eventTypes:Record<string,number> }
export interface ChatAttachment { name:string; url?:string|undefined; text?:string|undefined; mimeType?:string|undefined }

export interface AgentUploadedFile { id:string; filename:string; media_type:string; size_bytes:number; sha256?:string|undefined }
export interface AttachmentUploadResult { transport:"agent_service"|"inference_transcript"; fileId:string; conversationId?:string|undefined; fileName:string; mediaType:string; sizeBytes:number; sha256?:string|undefined; processedForInference?:boolean|undefined; target:{type:"user"}|{type:"thread";threadId:string}; file:AgentUploadedFile }
export interface LegacyAttachmentDownloadInput { url:string; fileName:string; mimeType?:string|undefined; permissionRecord:{table:string;id:string;spaceId:string} }
export interface AttachmentDownloadResult { source:"agent_service"|"inference_transcript"|"legacy_signed_url"; fileId?:string|undefined; fileName:string; mediaType:string; sizeBytes:number; path?:string|undefined; base64?:string|undefined; sha256?:string|undefined }

export type ChatJobStatus = "running"|"completed"|"failed"|"orphaned";
export interface ChatJobUsage { inputTokens:number; outputTokens:number }
export interface ChatJob { jobId:string; conversationId:string; status:ChatJobStatus; model:string; reasoningEffort?:string|undefined; promptPreview:string; turn:number; transport:"inference_transcript"|"agent_service"; startedAt:number; finishedAt?:number|undefined; text?:string|undefined; error?:string|undefined; usage?:ChatJobUsage|undefined }
export interface ChatStartResult { status:"running"; jobId:string; conversationId:string; model:string; reasoningEffort?:string|undefined; startedAt:number; rehydrated?:boolean|undefined; hint:string }
export interface CompletedChatResult extends ChatResult { status:"completed"; jobId:string; rehydrated?:boolean|undefined }
export interface PendingChatResult { status:"pending"; jobId:string; conversationId:string; model:string; reasoningEffort?:string|undefined; startedAt:number; elapsedMs:number; rehydrated?:boolean|undefined; hint:string }
export type ChatWaitResult = CompletedChatResult|PendingChatResult;
export interface ChatJobLookup { status:ChatJobStatus; source:"job"|"thread"; conversationId:string; jobId?:string|undefined; model?:string|undefined; reasoningEffort?:string|undefined; text?:string|undefined; error?:string|undefined; usage?:ChatJobUsage|undefined; startedAt?:number|undefined; finishedAt?:number|undefined; elapsedMs?:number|undefined; hint?:string|undefined }
