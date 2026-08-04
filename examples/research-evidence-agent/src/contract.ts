export interface ResearchSource {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly observedAt: string;
  readonly body: string;
}
export interface ResearchDocument {
  readonly title: string;
  readonly body: string;
  readonly citations: readonly {
    readonly title: string;
    readonly url: string;
  }[];
  readonly sourceDates: readonly {
    readonly sourceId: string;
    readonly publishedAt: string;
    readonly observedAt: string;
  }[];
  readonly observedSupport: readonly string[];
  readonly inferences: readonly string[];
}
