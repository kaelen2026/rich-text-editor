import { describe, expect, it } from "vitest";
import { coreMarks, coreNodes } from "./core-spec";

/**
 * 冻结核心集是持久化数据契约：名字落库后改名等于全量迁移（方案 §9.2、切片 §4）。
 * 这条用例把清单钉死——增删改任何一个名字都必须先改这里，改动因此一定会被看见。
 */
describe("冻结核心集", () => {
  it("节点名清单与方案 §9.2 完全一致", () => {
    expect(Object.keys(coreNodes).sort()).toEqual(
      [
        "doc",
        "text",
        "paragraph",
        "heading",
        "blockquote",
        "horizontal_rule",
        "bullet_list",
        "ordered_list",
        "list_item",
        "task_list",
        "task_item",
        "code_block",
        "hard_break",
        "unknown_block",
        "unknown_inline",
      ].sort(),
    );
  });

  it("标记名清单与方案 §9.2 完全一致", () => {
    expect(Object.keys(coreMarks).sort()).toEqual(
      ["strong", "em", "underline", "strikethrough", "code"].sort(),
    );
  });

  it("核心集不带命名空间前缀，插件才需要 co_", () => {
    for (const name of [...Object.keys(coreNodes), ...Object.keys(coreMarks)]) {
      expect(name.startsWith("co_")).toBe(false);
    }
  });

  it("段落排在其余块节点之前，`block+` 的默认块因此是段落", () => {
    const blocks = Object.entries(coreNodes)
      .filter(([, spec]) => spec.group === "block")
      .map(([name]) => name);
    expect(blocks[0]).toBe("paragraph");
  });
});
