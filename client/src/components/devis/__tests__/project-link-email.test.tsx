// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
const api=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/queryClient",()=>({apiRequest:api}));
import {ProjectLinkEmail} from "../ProjectLinkEmail";
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(enabled=true){
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}>
    <ProjectLinkEmail projectId="12" token={{id:4,clientEmail:"client@example.test",clientName:"Client"}} enabled={enabled}/>
  </QueryClientProvider>);
}
it("requires a review and explicit send, then shows provider acceptance",async()=>{
  api.mockImplementation(async(method:string)=>({json:async()=>method==="GET"?[]:{status:"sent"}}));
  mount();expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Email client"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"Send email"})).toBeEnabled());
  expect(screen.getByText(/client@example.test/)).toBeInTheDocument();
  expect(api.mock.calls.filter(c=>c[0]==="POST")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button",{name:"Send email"}));
  await screen.findByText(/Email sent — accepted/);
  expect(api.mock.calls.find(c=>c[0]==="POST")?.[2]).toMatchObject({tokenId:4});
  expect(screen.getByRole("button",{name:"Send email"})).toBeDisabled();
});
it("disables email when the current link cannot be sent",()=>{
  mount(false);expect(screen.getByRole("button",{name:"Email client"})).toBeDisabled();
});
it("shows the saved message before retrying a failed delivery",async()=>{
  api.mockResolvedValue({json:async()=>[{id:1,tokenId:4,status:"failed",recipient:"client@example.test",createdAt:new Date().toISOString(),body:"The saved message"}]});
  mount();fireEvent.click(screen.getByRole("button",{name:"Email client"}));
  await screen.findByText("The saved message");
  expect(screen.getByRole("button",{name:"Retry saved email"})).toBeEnabled();
});
