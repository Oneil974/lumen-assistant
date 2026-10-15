//! Human-facing browsing of original application data and profile sandboxes.
//! This is separate from the AI index: no change to AI permissions.
use std::{fs, path::{Path,PathBuf,Component},io::Read};
use serde_json::{Value,json};
use tauri::Manager;
const APP_FILES: &[&str]=&["kanban.json","reminders.json","contacts.json","inbox.json","mail.json","agents.json","tables.db","rag.db"];
fn base(app:&tauri::AppHandle)->Result<PathBuf,String>{crate::paths::shared_data_dir(app.path()).map_err(|e|e.to_string())}
fn sandboxes(app:&tauri::AppHandle,profile:&str)->Result<PathBuf,String>{
 let dir=base(app)?;
 let identity=crate::session::session_profiles(app.clone());
 let profiles=identity.get("profiles").and_then(Value::as_array).ok_or("Profils indisponibles")?;
 let p=profiles.iter().find(|p|p.get("id").and_then(Value::as_str)==Some(profile)).ok_or("Profil inconnu")?;
 if p.get("legacy_workspace").and_then(Value::as_bool).unwrap_or(false){Ok(dir.join("sandboxes"))}
 else{if profile.is_empty()||!profile.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'||c=='_'){return Err("Profil invalide".into());}Ok(dir.join("profiles").join(profile).join("sandboxes"))}
}
fn registry(app:&tauri::AppHandle,profile:&str)->Result<Vec<crate::sandbox::SandboxMeta>,String>{
 let p=sandboxes(app,profile)?.join("registry.json");if !p.exists(){return Ok(vec![]);}
 serde_json::from_slice(&fs::read(p).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
}
pub fn roots(app:&tauri::AppHandle,profile:&str)->Result<Value,String>{
 let mut roots=vec![json!({"id":"app-state","name":"États des applications"}),json!({"id":"applications","name":"Données des applications Lumen"})];
 for s in registry(app,profile)? {roots.push(json!({"id":format!("sandbox:{}",s.id),"name":format!("Sandbox · {}",s.name)}));}
 Ok(json!({"roots":roots}))
}
fn root(app:&tauri::AppHandle,profile:&str,id:&str)->Result<PathBuf,String>{
 match id {"app-state"=>Ok(base(app)?.join("app-state")),"applications"=>base(app),_=>{
 let id=id.strip_prefix("sandbox:").ok_or("Source inconnue")?;
 if !registry(app,profile)?.iter().any(|s|s.id==id){return Err("Sandbox inaccessible pour ce profil".into());}
 if id.is_empty()||!id.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'||c=='_'){return Err("Sandbox invalide".into());}
 Ok(sandboxes(app,profile)?.join(id).join("root"))
 }}
}
fn confined(root:&Path,rel:&str)->Result<PathBuf,String>{
 let rel=Path::new(rel);
 if rel.components().any(|c|!matches!(c,Component::Normal(_))){return Err("Chemin invalide".into());}
 let root=root.canonicalize().map_err(|e|e.to_string())?;
 let path=root.join(rel).canonicalize().map_err(|e|e.to_string())?;
 if !path.starts_with(&root){return Err("Chemin hors de la source".into());}Ok(path)
}
pub fn browse(app:&tauri::AppHandle,profile:&str,id:&str,rel:&str,offset:usize)->Result<Value,String>{
 if id=="applications" && !rel.is_empty() && !APP_FILES.contains(&rel){return Err("Donnée d’application inconnue".into());}
 let root=root(app,profile,id)?;
 if !root.exists() && rel.is_empty(){return Ok(json!({"entries":[],"total":0,"path":rel}));}
 let storage=base(app)?.canonicalize().map_err(|e|e.to_string())?;
 if !root.canonicalize().map_err(|e|e.to_string())?.starts_with(&storage){return Err("Source hors du stockage personnel".into());}
 let path=confined(&root,rel)?;
 if path.is_dir(){
 let mut entries=Vec::new();
 for e in fs::read_dir(&path).map_err(|e|e.to_string())?.flatten(){
 let name=e.file_name().to_string_lossy().to_string();
 if name.starts_with("._")||name==".DS_Store"||(id=="applications"&&!APP_FILES.contains(&name.as_str())){continue;}
 let Ok(target)=confined(&root,&if rel.is_empty(){name.clone()}else{format!("{rel}/{name}")}) else{continue;};
 let Ok(meta)=target.metadata() else{continue;};
 entries.push(json!({"name":name,"path":if rel.is_empty(){name.clone()}else{format!("{rel}/{name}")},"directory":meta.is_dir(),"bytes":meta.len()}));
 }
 entries.sort_by_key(|e|(e["directory"]!=true,e["name"].as_str().unwrap_or("").to_lowercase()));let total=entries.len();
 Ok(json!({"entries":entries.into_iter().skip(offset).take(60).collect::<Vec<_>>(),"total":total,"path":rel}))
 }else{
 if !path.is_file(){return Err("Ce type de fichier ne peut pas être consulté".into());}
 let bytes=path.metadata().map_err(|e|e.to_string())?.len();let mut content=Vec::new();fs::File::open(&path).map_err(|e|e.to_string())?.take(256*1024).read_to_end(&mut content).map_err(|e|e.to_string())?;
 let text=std::str::from_utf8(&content).ok().filter(|t|!t.contains('\0'));
 Ok(json!({"path":rel,"bytes":bytes,"text":text,"binary":text.is_none(),"truncated":bytes>content.len() as u64}))
 }
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn original_files_reject_traversal_and_escaping_symlinks(){
 let root=std::env::temp_dir().join(format!("vault-file-test-{}",std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir_all(&root).unwrap();fs::write(root.join("data.json"),"{}").unwrap();
 assert!(confined(&root,"data.json").is_ok());assert!(confined(&root,"../data.json").is_err());assert!(confined(&root,"/etc/passwd").is_err());
 #[cfg(unix)] {std::os::unix::fs::symlink("/etc",root.join("escape")).unwrap();assert!(confined(&root,"escape/passwd").is_err());}
 fs::remove_dir_all(root).unwrap();
 }
}
