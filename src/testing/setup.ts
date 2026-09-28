// 为 jsdom 提供 IndexedDB 实现；各测试需要全新数据库时再用 vi.stubGlobal 覆盖
import "fake-indexeddb/auto";
