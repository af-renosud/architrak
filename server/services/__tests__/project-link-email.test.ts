import {beforeEach, expect, it, vi} from "vitest";
const m=vi.hoisted(()=>({project:vi.fn(), saved:vi.fn(), send:vi.fn(), rows:[] as any[], insert:vi.fn(), token:null as any}));
vi.mock("../../storage",()=>({storage:{getProject:m.project,getProjectCommunication:m.saved}}));
vi.mock("../client-project-share",()=>({decryptShareUrl:()=> "https://example.test/p/client/project/secret",isTokenExpired:(t:any)=>t.expiresAt && t.expiresAt<new Date()}));
vi.mock("../communication-body-crypto",()=>({encryptCommunicationBody:(body:string)=>`encrypted:${body}`,PROTECTED_CLIENT_LINK_LABEL:"[protected]"}));
vi.mock("../../communications/email-sender",()=>({
  isValidRecipientEmail:()=>true,sendCommunication:m.send,
  CommunicationDeliveryAwaitingConfirmationError:class extends Error {},
  CommunicationSendInProgressError:class extends Error {},
}));
vi.mock("../../db",()=>({db:{transaction:async(fn:any)=>fn({
  execute:vi.fn(),
  select:()=>({from:()=>({where:()=>{
    const result=m.rows.shift() ?? [];
    return Object.assign(Promise.resolve(result),{for:async()=>result,limit:async()=>result});
  }})}),
  insert:()=>({values:(v:any)=>{m.insert(v);return {returning:async()=>[{id:91,...v}]};}}),
})}}));
import {emailProjectLink,buildProjectLinkEmail} from "../project-link-email";
const input={tokenId:4,requestId:"5e509bf7-6db7-4e33-a513-e43310e22800",message:"Please view your project."};
beforeEach(()=>{
  vi.clearAllMocks();m.project.mockResolvedValue({name:"Project",archivedAt:null});
  m.saved.mockResolvedValue({status:"sent",sentAt:new Date()});
  m.token={id:4,projectId:12,clientEmail:"client@example.test",clientName:"Client",encryptedShareUrl:"blob",expiresAt:null,revokedAt:null};
  m.rows=[[m.token],[],[]];
});
it("queues an encrypted existing link and sends with the operator identity",async()=>{
  expect((await emailProjectLink(12,9,input)).status).toBe("sent");
  const row=m.insert.mock.calls[0][0];
  expect(row.body).not.toContain("/secret");
  expect(row.encryptedBody).toContain("/project/secret");
  expect(row.encryptedBody).toContain("AT-PL-"+input.requestId);
  expect(m.send).toHaveBeenCalledWith(91,{sentByUserId:9});
});
it("does not send again on a repeated successful request",async()=>{
  m.rows=[[m.token],[{id:91,status:"sent"}]];
  await emailProjectLink(12,9,input);
  expect(m.insert).not.toHaveBeenCalled();expect(m.send).not.toHaveBeenCalled();
});
it("retries an existing failed email without replacing its body",async()=>{
  m.rows=[[m.token],[],[{id:55,status:"failed"}]];
  await emailProjectLink(12,9,input);
  expect(m.insert).not.toHaveBeenCalled();expect(m.send).toHaveBeenCalledWith(55,{sentByUserId:9});
});
it.each(["revoked","expired"])("blocks %s links",async kind=>{
  if(kind==="revoked")m.token.revokedAt=new Date();else m.token.expiresAt=new Date(0);
  await expect(emailProjectLink(12,9,input)).rejects.toThrow("changed or expired");
  expect(m.send).not.toHaveBeenCalled();
});
it("blocks archived projects",async()=>{
  m.project.mockResolvedValue({archivedAt:new Date()});
  await expect(emailProjectLink(12,9,input)).rejects.toThrow("archived");
});
it("uses an English message and strips subject newlines",()=>{
  const mail=buildProjectLinkEmail("Project\r\nInjected",null,"Message","url");
  expect(mail.subject).not.toMatch(/[\r\n]/);
  expect(mail.body).toContain("View your project here:");
});
