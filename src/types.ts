export interface AccountContext { tokenV2:string; userId:string; userName:string; userEmail:string; spaceId:string; spaceName:string; spaceViewId:string; timezone:string; clientVersion:string; browserId:string; deviceId:string; fullCookie?:string }
export interface WorkspaceInfo { spaceId:string; spaceViewId:string; spaceName:string; plan:string; createdTime:number|null }
export interface ConversationSummary { id:string; title:string; type:string; createdAt:number|null; updatedAt:number|null; messageCount:number; unread:boolean }
export interface ConversationMessage { id:string; role:"user"|"assistant"; text:string; createdAt:number|null }
export interface Conversation { id:string; title:string; type:string; createdAt:number|null; updatedAt:number|null; messages:ConversationMessage[] }
export interface ListConversationsResult { conversations:ConversationSummary[]; nextCursor:string|null; hasMore:boolean }
export interface ChatResult { conversationId:string; text:string; model:string; usage:{inputTokens:number;outputTokens:number} }
export interface ChatSession { threadId:string; configId:string; contextId:string; originalDatetime:string; model:string; updatedConfigIds:string[]; turnCount:number }
export interface ParsedInferenceStream { text:string; inputTokens:number; outputTokens:number; eventTypes:Record<string,number> }
export interface ChatAttachment { name:string; url?:string|undefined; text?:string|undefined; mimeType?:string|undefined }
