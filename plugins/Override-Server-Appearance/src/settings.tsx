import { ReactNative } from "@vendetta/metro/common";
import { Forms } from "@vendetta/ui/components";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";

import { statusLines } from "./status";

const { FormDivider, FormInput, FormRow } = Forms;

export default () => {
    useProxy(storage);

    const overrides: { id: string; icon: string; banner: string }[] = storage.overrides ?? [];

    const addOverride = () => {
        storage.overrides = [...overrides, { id: "", icon: "", banner: "" }];
    };

    const removeOverride = (index: number) => {
        storage.overrides = overrides.filter((_, i) => i !== index);
    };

    return (
        <ReactNative.ScrollView>
            {overrides.map((entry, index) => (
                <ReactNative.View key={index}>
                    <FormRow label={`Server ${index + 1}`} />
                    <FormInput
                        placeholder="Enter Target Server ID"
                        value={entry.id || ""}
                        onChange={(v) => (storage.overrides[index].id = v)}
                    />
                    <FormInput
                        placeholder="Enter server icon image URL (optional)"
                        value={entry.icon || ""}
                        onChange={(v) => (storage.overrides[index].icon = v)}
                    />
                    <FormInput
                        placeholder="Enter server banner image URL (optional)"
                        value={entry.banner || ""}
                        onChange={(v) => (storage.overrides[index].banner = v)}
                    />
                    <FormRow
                        label="Remove this server"
                        onPress={() => removeOverride(index)}
                    />
                    <FormDivider />
                </ReactNative.View>
            ))}
            <FormRow
                label="+ Add server"
                onPress={addOverride}
            />
            <FormDivider />
            <FormRow label="Status" />
            <ReactNative.View style={{ paddingHorizontal: 16, paddingBottom: 32 }}>
                {statusLines.map((line, i) => (
                    <ReactNative.Text key={i} selectable style={{ color: "#999999", fontSize: 12 }}>
                        {line}
                    </ReactNative.Text>
                ))}
            </ReactNative.View>
        </ReactNative.ScrollView>
    );
};
