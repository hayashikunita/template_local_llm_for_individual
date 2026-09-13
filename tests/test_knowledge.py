import pytest

from backend.knowledge import Knowledge


def test_registration_search_scope_and_delete(tmp_path):
    knowledge = Knowledge(tmp_path)
    original = "# 架空の規程\n交通費の上限は月額8000円です。\n申請日は毎月20日です。".encode()
    document = knowledge.register("規程.md", original)
    other = knowledge.register("別用途.txt", "交通費の上限は月額9000円です。".encode())
    sources = knowledge.search("交通費の上限は？", [document["id"]])
    assert len(sources) == 1
    assert sources[0]["document_id"] == document["id"]
    assert sources[0]["start_line"] == 1
    assert sources[0]["end_line"] == 3
    assert "8000" in sources[0]["content"]
    assert knowledge.original(document["id"]) == original
    assert knowledge.search("交通費", []) == []
    assert knowledge.search("存在しない単語", [document["id"]]) == []
    assert knowledge.delete(document["id"])
    assert knowledge.search("交通費", [document["id"]]) == []
    assert knowledge.original(document["id"]) is None
    assert knowledge.search("交通費", [other["id"]])
    with knowledge.connection() as database:
        assert database.execute("SELECT count(*) FROM search_index").fetchone()[0] == 1


@pytest.mark.parametrize("name, original", [
    ("../private.txt", b"test"), ("file.pdf", b"%PDF"), ("file.txt", b"\xff"),
    ("file.txt", b" "), ("file.txt", b"a\x00b"), ("file.txt", b"a" * 80001),
], ids=["path", "format", "encoding", "blank", "binary", "oversized"])
def test_invalid_document(tmp_path, name, original):
    knowledge = Knowledge(tmp_path)
    with pytest.raises(ValueError):
        knowledge.register(name, original)
    assert knowledge.listing() == []


def test_duplicate_restart_short_query_and_long_lines(tmp_path):
    knowledge = Knowledge(tmp_path)
    original = ("奈良\n" + "資料" * 1000).encode()
    document = knowledge.register("旅行.txt", original)
    with pytest.raises(ValueError):
        knowledge.register("duplicate.md", original)
    restored = Knowledge(tmp_path)
    assert restored.search("奈良", [document["id"]])
    assert all(len(source["content"]) <= 700 for source in restored.search("資料資料", [document["id"]]))