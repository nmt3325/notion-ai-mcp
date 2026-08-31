// Single source of truth for the tool surface. The stdio command smoke script and the
// server tests all compare against this list, so landing a tool means editing one place.
// A hardcoded count here is what failed CI when the keep-awake tools shipped.
export const EXPECTED_TOOL_NAMES: readonly string[] = [
  "add_mcp_connection",
  "check_keep_alive",
  "check_mcp_oauth_support",
  "complete_mcp_oauth",
  "connect_preconfigured_mcp_server",
  "create_workspace",
  "delete_conversation",
  "download_attachment",
  "get_chat_result",
  "get_conversation",
  "get_current_workspace",
  "get_mcp_connection_status",
  "interrupt_conversation",
  "keep_alive_kick",
  "keep_me_awake",
  "list_chat_jobs",
  "list_conversations",
  "list_keep_alives",
  "list_mcp_connections",
  "list_preconfigured_mcp_servers",
  "list_workspaces",
  "notion_ai_chat",
  "remove_mcp_connection",
  "rename_conversation",
  "start_mcp_oauth",
  "stop_keep_me_awake",
  "switch_workspace",
  "update_mcp_connection",
  "upload_attachment"
];
