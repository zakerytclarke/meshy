import { useEffect, useMemo, useRef, useState } from "react";
import { formatAgo, formatTime, hopCount, nodeName, shortName, threadKey } from "../lib/format";
import { useMesh } from "../state/MeshProvider";
import { BROADCAST_NUM, type ChatMessage, type ChatRef, type NodeRecord } from "../types";

export function Messages() {
  const mesh = useMesh();
  const [picking, setPicking] = useState<"channel" | "dm" | null>(null);
  const open = mesh.activeChat != null;

  const channels =
    mesh.channels.length > 0 || mesh.status !== "connected"
      ? mesh.channels
      : [{ index: 0, name: "Primary", role: "primary" }];
  const threads = useMemo(() => buildThreads(channels, mesh.messages, mesh.nodes, mesh.myNodeNum, mesh.activeChat), [
    channels,
    mesh.messages,
    mesh.nodes,
    mesh.myNodeNum,
    mesh.activeChat,
  ]);

  return (
    <div className={open ? "messages is-open" : "messages"}>
      <section className="thread-list">
        <div className="section-head">
          <h2>Channels</h2>
          <button className="text-button" onClick={() => setPicking("channel")}>
            Add
          </button>
        </div>
        {threads.channels.length === 0 ? (
          <p className="empty-inline">Channels show up here after the radio connects.</p>
        ) : (
          threads.channels.map((thread) => (
            <ThreadRow
              key={thread.key}
              thread={thread}
              active={sameChat(mesh.activeChat, thread.chat)}
              unread={unreadCount(mesh.messages, thread.chat, mesh.myNodeNum, mesh.readAt)}
              onOpen={() => mesh.openChat(thread.chat)}
            />
          ))
        )}
        <div className="section-head">
          <h2>People</h2>
          <button className="text-button" onClick={() => setPicking("dm")}>
            New
          </button>
        </div>
        {threads.dms.length === 0 ? (
          <p className="empty-inline">Direct messages appear when you write someone, or when they write you.</p>
        ) : (
          threads.dms.map((thread) => (
            <ThreadRow
              key={thread.key}
              thread={thread}
              active={sameChat(mesh.activeChat, thread.chat)}
              unread={unreadCount(mesh.messages, thread.chat, mesh.myNodeNum, mesh.readAt)}
              onOpen={() => mesh.openChat(thread.chat)}
            />
          ))
        )}
      </section>
      <Chat />
      {picking === "channel" ? <ChannelDialog onClose={() => setPicking(null)} /> : null}
      {picking === "dm" ? <PeopleDialog onClose={() => setPicking(null)} /> : null}
    </div>
  );
}

function Chat() {
  const mesh = useMesh();
  const scroller = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const chat = mesh.activeChat;
  const items = chat ? mesh.messages.filter((message) => inThread(message, chat, mesh.myNodeNum)) : [];

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [items.length, chat?.kind, chat?.id]);

  if (!chat) {
    return (
      <section className="thread empty-thread">
        <div>
          <h2>Messages</h2>
          <p>Pick a channel, or start a direct message. Sends wait until another radio answers.</p>
          {mesh.status !== "connected" ? (
            <button className="primary" onClick={() => mesh.connect()}>
              Connect radio
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  const title =
    chat.kind === "channel"
      ? mesh.channels.find((channel) => channel.index === chat.id)?.name || `Channel ${chat.id}`
      : nodeName(mesh.nodes, chat.id, mesh.myNodeNum);
  const person = chat.kind === "dm" ? mesh.nodes.find((node) => node.num === chat.id) : undefined;

  return (
    <section className="thread">
      <header className="thread-top">
        <button className="text-button back" onClick={mesh.closeChat}>
          Back
        </button>
        <div>
          <h2>{title}</h2>
          <p>{chat.kind === "channel" ? "Everyone on this channel" : personLine(person)}</p>
        </div>
      </header>
      <div className="bubbles" ref={scroller}>
        {items.length === 0 ? <p className="empty-inline">No messages in this conversation yet.</p> : null}
        {items.map((message) => (
          <Bubble key={message.id} message={message} mine={message.outgoing || message.from === mesh.myNodeNum} />
        ))}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          const next = text.trim();
          if (!next) return;
          mesh.sendMessage(next);
          setText("");
        }}
      >
        <input
          value={text}
          maxLength={200}
          placeholder={mesh.status === "connected" ? "Write a message" : "Connect the radio to send"}
          onChange={(event) => setText(event.target.value)}
        />
        <button className="primary" type="submit" disabled={!text.trim() || mesh.status !== "connected"}>
          Send
        </button>
      </form>
    </section>
  );
}

function Bubble({ message, mine }: { message: ChatMessage; mine: boolean }) {
  const mesh = useMesh();
  const sender = mine ? "You" : nodeName(mesh.nodes, message.from, mesh.myNodeNum);
  return (
    <article className={mine ? "bubble mine" : "bubble"}>
      {mine ? null : <span className="who">{sender}</span>}
      <p>{message.text}</p>
      <footer>
        <time>{formatTime(message.time)}</time>
        <span>{deliveryText(message)}</span>
      </footer>
    </article>
  );
}

function deliveryText(message: ChatMessage): string {
  if (message.delivery === "pending") return "Sending";
  if (message.delivery === "failed") return message.detail || "Not heard";
  if (message.delivery === "hit-mesh") return message.detail || "Crossed the mesh";
  if (message.delivery === "hit-node") return message.detail || "Reached a node";
  if (message.hops != null && message.hops >= 2) return `Via the mesh · ${message.hops} hops`;
  if (message.hops === 1) return "Relayed once";
  if (message.hops === 0) return "Direct";
  if (message.snr != null) return `SNR ${message.snr.toFixed(1)} dB`;
  return "Received";
}

function ChannelDialog({ onClose }: { onClose: () => void }) {
  const mesh = useMesh();
  const [name, setName] = useState("");
  const [keyText, setKeyText] = useState("");
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="channel-title">
      <form
        className="sheet"
        onSubmit={(event) => {
          event.preventDefault();
          void mesh.addChannel(name, keyText).then((saved) => {
            if (saved) onClose();
          });
        }}
      >
        <h2 id="channel-title">Add a channel</h2>
        <p>This adds an extra channel on the radio. Your main channel stays as it is.</p>
        <label>
          Name
          <input value={name} maxLength={11} onChange={(event) => setName(event.target.value)} placeholder="Camp" />
        </label>
        <label>
          Key or share link
          <input
            value={keyText}
            onChange={(event) => setKeyText(event.target.value)}
            placeholder="Leave blank to generate a key"
          />
        </label>
        <div className="row-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={mesh.status !== "connected" || mesh.busy != null}>
            {mesh.busy ?? "Add channel"}
          </button>
        </div>
        {mesh.status !== "connected" ? <p className="hint">Connect the radio first. The channel is stored on the device.</p> : null}
      </form>
    </div>
  );
}

function PeopleDialog({ onClose }: { onClose: () => void }) {
  const mesh = useMesh();
  const [query, setQuery] = useState("");
  const people = mesh.nodes
    .filter((node) => node.num !== mesh.myNodeNum)
    .filter((node) => {
      const haystack = `${node.longName} ${node.shortName}`.toLowerCase();
      return haystack.includes(query.trim().toLowerCase());
    })
    .sort((a, b) => (b.lastHeard ?? 0) - (a.lastHeard ?? 0));
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="people-title">
      <div className="sheet">
        <h2 id="people-title">Message someone</h2>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search nodes" />
        <div className="people">
          {people.length === 0 ? <p className="empty-inline">No other nodes yet. They show up when the radio hears them.</p> : null}
          {people.map((node) => (
            <button
              key={node.num}
              className="person"
              onClick={() => {
                mesh.messageNode(node.num);
                onClose();
              }}
            >
              <b>{shortName(mesh.nodes, node.num, mesh.myNodeNum)}</b>
              <span>
                <strong>{node.longName}</strong>
                <small>
                  {hopCount(node.hopsAway)} · {formatAgo(node.lastHeard)}
                </small>
              </span>
            </button>
          ))}
        </div>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function ThreadRow({
  thread,
  active,
  unread,
  onOpen,
}: {
  thread: Thread;
  active: boolean;
  unread: number;
  onOpen: () => void;
}) {
  return (
    <button className={active ? "thread-row active" : "thread-row"} onClick={onOpen}>
      <b>{thread.mark}</b>
      <span>
        <strong>{thread.title}</strong>
        <small>{thread.preview}</small>
      </span>
      {unread > 0 ? <em>{unread}</em> : <time>{thread.when}</time>}
    </button>
  );
}

interface Thread {
  key: string;
  chat: ChatRef;
  title: string;
  mark: string;
  preview: string;
  when: string;
  last: number;
}

function buildThreads(
  channels: { index: number; name: string; role: string }[],
  messages: ChatMessage[],
  nodes: NodeRecord[],
  myNum: number,
  active: ChatRef | null,
): { channels: Thread[]; dms: Thread[] } {
  const channelThreads = channels
    .filter((channel) => channel.role !== "disabled")
    .map((channel) => {
      const chat: ChatRef = { kind: "channel", id: channel.index };
      const last = lastMessage(messages, chat, myNum);
      return {
        key: threadKey("channel", channel.index),
        chat,
        title: channel.name,
        mark: channel.name.slice(0, 2).toUpperCase() || "CH",
        preview: last?.text || "No messages yet",
        when: last ? formatTime(last.time) : "",
        last: last?.time ?? 0,
      };
    });

  const ids = new Set<number>();
  for (const message of messages) {
    if (!message.direct) continue;
    const other = message.from === myNum ? message.to : message.from;
    if (other && other !== BROADCAST_NUM && other !== myNum) ids.add(other);
  }
  if (active?.kind === "dm") ids.add(active.id);
  const dms = [...ids]
    .map((id) => {
      const chat: ChatRef = { kind: "dm", id };
      const last = lastMessage(messages, chat, myNum);
      const node = nodes.find((item) => item.num === id);
      return {
        key: threadKey("dm", id),
        chat,
        title: nodeName(nodes, id, myNum),
        mark: shortName(nodes, id, myNum),
        preview: `${hopCount(node?.hopsAway)} · ${last?.text || "No messages yet"}`,
        when: last ? formatTime(last.time) : "",
        last: last?.time ?? 0,
      };
    })
    .sort((a, b) => b.last - a.last);

  return { channels: channelThreads, dms };
}

function lastMessage(messages: ChatMessage[], chat: ChatRef, myNum: number): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && inThread(message, chat, myNum)) return message;
  }
  return undefined;
}

function inThread(message: ChatMessage, chat: ChatRef, myNum: number): boolean {
  if (chat.kind === "channel") return !message.direct && message.channel === chat.id;
  return message.direct && ((message.from === chat.id && message.to === myNum) || (message.from === myNum && message.to === chat.id));
}

function sameChat(a: ChatRef | null, b: ChatRef): boolean {
  return a?.kind === b.kind && a.id === b.id;
}

function unreadCount(messages: ChatMessage[], chat: ChatRef, myNum: number, readAt: Record<string, number>): number {
  const seen = readAt[threadKey(chat.kind, chat.id)] ?? 0;
  return messages.filter((message) => inThread(message, chat, myNum) && !message.outgoing && message.time > seen).length;
}

function personLine(node: NodeRecord | undefined): string {
  if (!node) return "Direct message";
  if (node.hopsAway == null) return "Direct message";
  if (node.hopsAway <= 0) return "Direct neighbor";
  return `${node.hopsAway} hop${node.hopsAway === 1 ? "" : "s"} away`;
}
