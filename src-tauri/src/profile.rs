//! The character's public profile on the official site: no login, the same
//! JSON the profile page reads. Endpoints and parameters as documented by
//! github.com/nuriland/aion2-api (MIT).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const SITE: &str = "https://aion2.plaync.com";
const SEARCH: &str = "https://api-search.plaync.com/aion2global/search/v2/character";
const LANG: &str = "pt-BR";
const USER_AGENT: &str = "Kiskwatch (github.com/leogimenes/kiskwatch)";

/// The Global shard a region id (the server id's second digit) is served from.
pub fn shard(region: u32) -> Option<&'static str> {
    Some(match region {
        1 => "nae",
        2 => "naw",
        3 => "eu",
        4 => "la",
        5 => "as",
        _ => return None,
    })
}

/// A search hit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hit {
    pub character_id: String,
    pub name: String,
    pub level: u32,
    pub server_id: u32,
    pub server_name: String,
    pub race: u32,
    pub pc_id: u32,
}

/// What Kiskwatch keeps of a character: the official JSON, as sent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Profile {
    pub server_id: u32,
    pub character_id: String,
    pub name: String,
    /// `/api/character/info`: profile, stats, Daevanion boards.
    pub info: Value,
    /// `/api/character/equipment`: gear, skills and stigmas, pet and wings.
    pub equipment: Value,
    /// `/api/character/daevanion/detail` by board id: each node, open or not.
    pub boards: BTreeMap<u32, Value>,
    pub fetched_ms: i64,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

async fn get(client: &reqwest::Client, url: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let res = client.get(url).query(query).send().await.map_err(|e| format!("sem conexão com o site oficial: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("o site oficial respondeu {status}"));
    }
    res.json().await.map_err(|e| format!("resposta inesperada do site oficial: {e}"))
}

/// Ids in search results and profile links come percent-encoded (…%3D);
/// sent encoded again, the site answers 404.
fn decode_id(id: &str) -> String {
    urlencoding::decode(id).map(|s| s.into_owned()).unwrap_or_else(|_| id.to_string())
}

/// Search hits are highlighted with <strong>.
fn plain(name: &str) -> String {
    name.replace("<strong>", "").replace("</strong>", "")
}

pub async fn search(region: u32, server_id: u32, name: &str) -> Result<Vec<Hit>, String> {
    let shard = shard(region).ok_or("região sem perfil oficial")?;
    let mut query = vec![
        ("keyword", name.to_string()),
        ("page", "1".into()),
        ("size", "40".into()),
        ("region", shard.into()),
        ("localeInfo", LANG.into()),
    ];
    if server_id > 0 {
        query.push(("serverId", server_id.to_string()));
    }
    let raw = get(&client()?, SEARCH, &query).await?;
    let rows = raw.get("list").and_then(Value::as_array).ok_or("resposta da busca sem lista")?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            Some(Hit {
                character_id: decode_id(r.get("characterId")?.as_str()?),
                name: plain(r.get("name")?.as_str()?),
                level: r.get("level").and_then(Value::as_u64).unwrap_or(0) as u32,
                server_id: r.get("serverId")?.as_u64()? as u32,
                server_name: r.get("serverName").and_then(Value::as_str).unwrap_or("").to_string(),
                race: r.get("race").and_then(Value::as_u64).unwrap_or(0) as u32,
                pc_id: r.get("pcId").and_then(Value::as_u64).unwrap_or(0) as u32,
            })
        })
        .collect())
}

/// A player the game named, on any server of the region: exact names first,
/// on your server first. Players from other servers meet in dungeons.
pub async fn find(region: u32, my_server: u32, name: &str) -> Result<Vec<Hit>, String> {
    Ok(rank(search(region, 0, name).await?, my_server, name))
}

fn rank(hits: Vec<Hit>, my_server: u32, name: &str) -> Vec<Hit> {
    let exact: Vec<Hit> = hits.iter().filter(|h| h.name.to_lowercase() == name.to_lowercase()).cloned().collect();
    let mut list = if exact.is_empty() { hits } else { exact };
    list.sort_by_key(|h| h.server_id != my_server);
    list
}

/// The board ids in an info response.
fn board_ids(info: &Value) -> Vec<u32> {
    info.pointer("/daevanion/boardList")
        .and_then(Value::as_array)
        .map(|l| l.iter().filter_map(|b| b.get("id")?.as_u64().map(|id| id as u32)).collect())
        .unwrap_or_default()
}

pub async fn fetch(region: u32, server_id: u32, character_id: &str, now_ms: i64) -> Result<Profile, String> {
    let shard = shard(region).ok_or("região sem perfil oficial")?;
    let client = client()?;
    let id = decode_id(character_id);
    let query = |extra: Option<(&'static str, String)>| {
        let mut q = vec![
            ("lang", LANG.to_string()),
            ("region", shard.to_string()),
            ("serverId", server_id.to_string()),
            ("characterId", id.clone()),
        ];
        q.extend(extra);
        q
    };
    let info = get(&client, &format!("{SITE}/api/character/info"), &query(None)).await?;
    if info.get("profile").is_none_or(Value::is_null) {
        return Err("personagem não encontrado".into());
    }
    let equipment = get(&client, &format!("{SITE}/api/character/equipment"), &query(None)).await?;
    let mut boards = BTreeMap::new();
    for board in board_ids(&info) {
        // A board this character hasn't opened yet can fail; the rest still count.
        if let Ok(detail) = get(&client, &format!("{SITE}/api/character/daevanion/detail"), &query(Some(("boardId", board.to_string())))).await {
            boards.insert(board, detail);
        }
    }
    let name = info.pointer("/profile/characterName").and_then(Value::as_str).unwrap_or("").to_string();
    Ok(Profile { server_id, character_id: id, name, info, equipment, boards, fetched_ms: now_ms })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_ids_once() {
        assert_eq!(decode_id("AAAAtest_-0001%3D"), "AAAAtest_-0001=");
        assert_eq!(decode_id("AAAAtest_-0001="), "AAAAtest_-0001=");
    }

    #[test]
    fn strips_highlight() {
        assert_eq!(plain("Delt<strong>a</strong>"), "Delta");
    }

    #[test]
    fn reads_board_ids() {
        let info = serde_json::json!({ "daevanion": { "boardList": [{ "id": 71 }, { "id": 72 }] } });
        assert_eq!(board_ids(&info), vec![71, 72]);
    }

    fn hit(name: &str, server_id: u32) -> Hit {
        Hit { character_id: name.into(), name: name.into(), level: 45, server_id, server_name: String::new(), race: 1, pc_id: 0 }
    }

    #[test]
    fn finds_the_exact_name_on_your_server_first() {
        let hits = vec![hit("Amigos", 1406), hit("Amigo", 1401), hit("amigo", 1406)];
        let found: Vec<_> = rank(hits, 1406, "Amigo").into_iter().map(|h| (h.name, h.server_id)).collect();
        assert_eq!(found, [("amigo".to_string(), 1406), ("Amigo".to_string(), 1401)]);
        assert_eq!(rank(vec![hit("Amigos", 1406)], 1406, "Amigo").len(), 1, "no exact name: every hit");
    }

    #[test]
    fn south_america_is_la() {
        assert_eq!(shard(4), Some("la"));
        assert_eq!(shard(9), None);
    }
}
