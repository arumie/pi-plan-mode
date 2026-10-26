import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

export function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

export function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}
