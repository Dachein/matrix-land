import { Text, View } from "@tarojs/components";

/** Module-scope elements so the indicator stays referentially stable across streaming renders. */
const DOTS = [<Text key="d1">•</Text>, <Text key="d2">•</Text>, <Text key="d3">•</Text>];

export function TypingIndicator({ inline = false, label = "" }: { inline?: boolean; label?: string }) {
  return <View className={`typing ${inline ? "typing-inline" : ""}`}>
    {label && <Text className="typing-label">{label}</Text>}
    {DOTS}
  </View>;
}
