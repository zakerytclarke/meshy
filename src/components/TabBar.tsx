import type { ReactElement } from "react";
import { IconLogs, IconMap, IconMessages, IconRadio } from "./Icons";
import { useMesh } from "../state/MeshProvider";
import { BROADCAST_NUM, type TabId } from "../types";
import { threadKey } from "../lib/format";

const TABS: { id: TabId; label: string; icon: () => ReactElement }[] = [
  { id: "messages", label: "Messages", icon: IconMessages },
  { id: "map", label: "Map", icon: IconMap },
  { id: "radio", label: "Radio", icon: IconRadio },
  { id: "logs", label: "Logs", icon: IconLogs },
];

export function TabBar() {
  const mesh = useMesh();
  const unread = mesh.messages.filter((message) => {
    if (message.outgoing || message.from === mesh.myNodeNum) return false;
    const chat = message.direct
      ? { kind: "dm" as const, id: message.from === mesh.myNodeNum ? message.to : message.from }
      : { kind: "channel" as const, id: message.channel };
    if (message.direct && (chat.id === BROADCAST_NUM || chat.id === 0)) return false;
    const seen = mesh.readAt[threadKey(chat.kind, chat.id)] ?? 0;
    return message.time > seen;
  }).length;

  return (
    <nav className="tabbar" aria-label="Sections">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const current = mesh.tab === tab.id;
        return (
          <button
            key={tab.id}
            className={current ? "tab current" : "tab"}
            aria-current={current ? "page" : undefined}
            onClick={() => mesh.setTab(tab.id)}
          >
            <Icon />
            <span>{tab.label}</span>
            {tab.id === "messages" && unread > 0 ? <em>{unread > 9 ? "9+" : unread}</em> : null}
          </button>
        );
      })}
    </nav>
  );
}
