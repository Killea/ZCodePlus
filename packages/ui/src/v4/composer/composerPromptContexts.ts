import {
  buildPromptWithCodeComments,
  parsePromptCodeComments,
  type CodeCommentComposerAttachment,
} from "@/lib/codeCommentContext.js";
import {
  buildPromptWithConversationSelections,
  parsePromptConversationSelections,
  type ConversationSelectionDisplayReference,
} from "@/lib/conversationSelectionReference.js";
import {
  buildPromptWithWebElementContexts,
  parsePromptWebElementContexts,
  type WebElementContextComposerAttachment,
} from "@/lib/webElementContext.js";
import {
  buildPromptWithPptxElementReferences,
  parsePromptPptxElementReferences,
  type PptxElementReference,
} from "@/lib/pptxElementReference.js";
import {
  buildPromptWithPluginUiContexts,
  parsePromptPluginUiContexts,
  type PluginUiModelContext,
} from "@/plugin-ui/index.js";
import {
  buildPromptWithToolRecommendations,
  parsePromptToolRecommendations,
  type ComposerToolRecommendation,
} from "@/v4/composer/composerToolRecommendations.js";

export interface ComposerPromptContexts {
  codeComments: readonly CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: readonly WebElementContextComposerAttachment[];
  pptxElements: readonly PptxElementReference[];
  /** 插件 UI 经 ui/update-model-context 附加；缺省视为空。 */
  pluginUiContexts?: readonly PluginUiModelContext[];
  /** 用户选定的推荐能力；缺省视为空（旧调用方与历史 prompt 不带该块，不能按必选读取）。 */
  toolRecommendations?: readonly ComposerToolRecommendation[];
}

export function countComposerPromptContexts(contexts: {
  codeComments: readonly unknown[];
  conversationSelections: readonly unknown[];
  webElements: readonly unknown[];
  pptxElements: readonly unknown[];
  pluginUiContexts?: readonly unknown[];
  toolRecommendations?: readonly unknown[];
}) {
  return (
    contexts.codeComments.length +
    contexts.conversationSelections.length +
    contexts.webElements.length +
    contexts.pptxElements.length +
    (contexts.pluginUiContexts?.length ?? 0) +
    (contexts.toolRecommendations?.length ?? 0)
  );
}

/**
 * 六类 context parser 都只识别 prompt 尾块，因此序列化顺序和解析顺序必须严格相反。
 * 插件上下文最后序列化（最外层），解析时最先剥离；工具推荐块紧随其后（内层）。
 */
export function serializeComposerPromptContexts(
  text: string,
  contexts: ComposerPromptContexts,
): string {
  const withSelections = buildPromptWithConversationSelections(
    text,
    contexts.conversationSelections,
  );
  const withCodeComments = buildPromptWithCodeComments(withSelections, contexts.codeComments);
  const withWebElements = buildPromptWithWebElementContexts(withCodeComments, contexts.webElements);
  const withPptx = buildPromptWithPptxElementReferences(withWebElements, contexts.pptxElements);
  // 与 pluginUiContexts 同款：不带工具推荐块的 contexts（旧调用方/测试夹具）按空处理，
  // 不能透传 undefined 到 buildToolRecommendationsBlock（内部直接读 .length）。
  const withTools = buildPromptWithToolRecommendations(
    withPptx,
    contexts.toolRecommendations ?? [],
  );
  return buildPromptWithPluginUiContexts(withTools, contexts.pluginUiContexts ?? []);
}

export function parseComposerPromptContexts(
  content: string,
  workspace: { workspacePath: string; workspaceIdentity?: string },
): {
  visibleContent: string;
  codeComments: CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: WebElementContextComposerAttachment[];
  pptxElements: PptxElementReference[];
  pluginUiContexts: PluginUiModelContext[];
  toolRecommendations: ComposerToolRecommendation[];
} {
  const plugin = parsePromptPluginUiContexts(content);
  const tools = parsePromptToolRecommendations(plugin.visibleContent);
  const pptx = parsePromptPptxElementReferences(tools.visibleContent);
  const web = parsePromptWebElementContexts(pptx.visibleContent, workspace);
  const code = parsePromptCodeComments(web.visibleContent, workspace);
  const selections = parsePromptConversationSelections(code.visibleContent);
  return {
    visibleContent: selections.visibleContent,
    codeComments: code.codeCommentAttachments,
    conversationSelections: selections.references,
    webElements: web.webElementContexts,
    pptxElements: pptx.pptxElementReferences,
    pluginUiContexts: plugin.pluginUiContexts,
    toolRecommendations: tools.toolRecommendations,
  };
}
