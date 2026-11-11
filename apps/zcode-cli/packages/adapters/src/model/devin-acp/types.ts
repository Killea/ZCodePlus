/** ACP prompt part 与 session/update 归一化后的内部事件类型。 */

export type DevinAcpPromptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "resource";
      readonly resource: {
        readonly uri: string;
        readonly text: string;
        readonly mimeType?: string;
      };
    };

export type DevinAcpUpdate =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thought"; readonly text: string }
  | { readonly kind: "tool"; readonly title: string; readonly status?: string }
  | { readonly kind: "plan"; readonly text: string }
  | {
      /** Devin 自管上下文窗口的实时占用（usage_update.used/size），非本轮 token 账本。 */
      readonly kind: "usage";
      readonly used: number;
      readonly size: number;
      readonly cost?: { readonly amount: number; readonly currency: string };
    };
