---
name: dsh-superagent-gitlab
description: Read GitLab issues, merge requests, discussions and pipelines, and open merge requests with gitlab-mr.
---

Workers use orchestrator_read for project context when needed: gitlab/issues/<iid> or gitlab/merge_requests/<iid> for the description; append /notes/<page> for a page of conversation comments; append /discussions for the code discussions of a merge request. A message is `{ id, from, at, text, reply_to?, path?, line?, url }`: `id` is GitLab's note id, `path` and `line` a code comment's file and position, and `bot: true` marks a project access token account, whose words never authorize work. Reading does not create tickets or send replies.

The execution environment names the project and the agent account. Push branches with plain git: the credential helper supplies the project access token, so never paste a token.

Open or inspect a merge request with `gitlab-mr`, which speaks the project API with that token:

```
gitlab-mr issue <iid>
gitlab-mr create --source-branch agent/<name> --target-branch <base> --title '<title>' --description '<description>'
gitlab-mr view <iid>
gitlab-mr merge <iid> --squash [--sha <sha>]
```

`gitlab-mr issue <iid>` prints an Issue's `{ iid, title, description, state, author, web_url }`; read the originating Issue with it before working on a request that references one.

`create` prints `{ iid, state, web_url }`; report the MR in `orchestrator_report` with `state: progress` immediately after creating it. The host binds the MR when its source branch ends with `$DSH_SUPERAGENT_NAME` and follows it; a person merges it, and merging ends the ticket.

Before substantial work on a new human request or code comment, call `orchestrator_ack` with its original trigger ID; the host replies once in that source thread. Do not acknowledge bots or CI. Answer code discussions where they were raised. Do not merge a merge request unless the Delivery requirements section names a merge command and its conditions hold.
