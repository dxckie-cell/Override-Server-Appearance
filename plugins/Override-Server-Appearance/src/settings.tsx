import { ReactNative } from "@vendetta/metro/common";
import { Forms } from "@vendetta/ui/components";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";

const { FormDivider, FormInput, FormRow } = Forms;

export default () => {
    useProxy(storage);

    const overrides: { id: string; icon: string; banner: string }[] = storage.overrides ?? [];

    return (
        <ReactNative.ScrollView>
            {overrides.map((entry, index) => (
                <ReactNative.View key={index}>
                    <FormRow label={`Server ${index + 1}`} />
                    <FormInput
                        placeholder="Server ID"
                        value={entry.id || ""}
                        onChange={(v) => (storage.overrides[index].id = v)}
                    />
                    <FormInput
                        placeholder="Icon image URL (optional)"
                        value={entry.icon || ""}
                        onChange={(v) => (storage.overrides[index].icon = v)}
                    />
                    <FormInput
                        placeholder="Banner image URL (optional)"
                        value={entry.banner || ""}
                        onChange={(v) => (storage.overrides[index].banner = v)}
                    />
                    <FormRow
                        label="Remove this server"
                        onPress={() => (storage.overrides = overrides.filter((_, i) => i !== index))}
                    />
                    <FormDivider />
                </ReactNative.View>
            ))}
            <FormRow
                label="+ Add server"
                onPress={() => (storage.overrides = [...overrides, { id: "", icon: "", banner: "" }])}
            />
        </ReactNative.ScrollView>
    );
};
