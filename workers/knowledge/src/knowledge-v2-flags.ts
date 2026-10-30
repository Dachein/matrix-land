export type KnowledgeV2FlagEnv = {
  KNOWLEDGE_V2_INDEX_READ_ENABLED?: string;
  KNOWLEDGE_V2_MUTATION_SPINE_ENABLED?: string;
  KNOWLEDGE_V2_ROOT_ACL_ENABLED?: string;
  KNOWLEDGE_V2_SHADOW_READ_ENABLED?: string;
};

export type KnowledgeV2Flags = {
  indexRead: boolean;
  mutationSpine: boolean;
  rootAcl: boolean;
  shadowRead: boolean;
};

function explicitlyEnabled(value: string | undefined) {
  return value?.trim() === "1";
}

export function knowledgeV2Flags(env: KnowledgeV2FlagEnv): KnowledgeV2Flags {
  return {
    indexRead: explicitlyEnabled(env.KNOWLEDGE_V2_INDEX_READ_ENABLED),
    mutationSpine: explicitlyEnabled(env.KNOWLEDGE_V2_MUTATION_SPINE_ENABLED),
    rootAcl: explicitlyEnabled(env.KNOWLEDGE_V2_ROOT_ACL_ENABLED),
    shadowRead: explicitlyEnabled(env.KNOWLEDGE_V2_SHADOW_READ_ENABLED)
  };
}
