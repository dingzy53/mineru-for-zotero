import { assert } from "chai";
import {
  createMarkdownQueryEndpoint,
  createMarkdownQueryEndpointClass,
  MARKDOWN_ENDPOINT_PATHS,
} from "../src/modules/markdownQuery/apiEndpoint";
import {
  setMarkdownApiEnabled,
  setMarkdownApiRequireToken,
  setMarkdownApiToken,
} from "../src/utils/prefs";

describe("markdownApiEndpoint", function () {
  afterEach(function () {
    setMarkdownApiEnabled(false);
    setMarkdownApiRequireToken(true);
    setMarkdownApiToken("");
  });

  it("returns api-disabled when the API is off", async function () {
    setMarkdownApiEnabled(false);
    const endpoint = createMarkdownQueryEndpoint(fakeService());
    const response = await endpoint.init(
      request("/mineru-for-zotero/markdown"),
    );

    assert.deepEqual(response, [
      403,
      "application/json",
      JSON.stringify({
        error: "api-disabled",
        message: "Markdown query API is disabled",
      }),
    ]);
  });

  it("rejects missing tokens when token auth is required", async function () {
    setMarkdownApiEnabled(true);
    setMarkdownApiRequireToken(true);
    setMarkdownApiToken("secret");
    const endpoint = createMarkdownQueryEndpoint(fakeService());

    const response = await endpoint.init(
      request("/mineru-for-zotero/markdown"),
    );

    assert.include(String(response[2]), "invalid-token");
  });

  it("accepts bearer tokens", async function () {
    setMarkdownApiEnabled(true);
    setMarkdownApiRequireToken(true);
    setMarkdownApiToken("secret");
    const endpoint = createMarkdownQueryEndpoint(fakeService());

    const response = await endpoint.init(
      request("/mineru-for-zotero/markdown", {
        headers: { authorization: "Bearer secret" },
        query: { libraryID: "1", key: "PDF1" },
      }),
    );

    assert.equal(response[0], 200);
    assert.include(String(response[2]), "# Body");
  });

  it("accepts query tokens", async function () {
    setMarkdownApiEnabled(true);
    setMarkdownApiRequireToken(true);
    setMarkdownApiToken("secret");
    const endpoint = createMarkdownQueryEndpoint(fakeService());

    const response = await endpoint.init(
      request("/mineru-for-zotero/search", {
        query: { libraryID: "1", title: "Doc", token: "secret" },
      }),
    );

    assert.equal(response[0], 200);
    assert.include(String(response[2]), '"candidates":[]');
  });

  it("creates a constructible Zotero endpoint class", async function () {
    setMarkdownApiEnabled(true);
    setMarkdownApiRequireToken(false);
    const EndpointClass = createMarkdownQueryEndpointClass(fakeService());
    const endpoint = new EndpointClass();

    const response = await endpoint.init(
      runtimeRequest("/mineru-for-zotero/markdown", {
        searchParams: new URLSearchParams({ libraryID: "1", key: "PDF1" }),
      }),
    );

    assert.equal(response[0], 200);
    assert.include(String(response[2]), "# Body");
  });

  it("reads query parameters from Zotero runtime searchParams", async function () {
    setMarkdownApiEnabled(true);
    setMarkdownApiRequireToken(false);
    const endpoint = createMarkdownQueryEndpoint(fakeService());

    const response = await endpoint.init(
      runtimeRequest("/mineru-for-zotero/search", {
        searchParams: new URLSearchParams({ libraryID: "1", title: "Doc" }),
      }),
    );

    assert.equal(response[0], 200);
    assert.include(String(response[2]), '"candidates":[]');
  });

  it("uses a generic internal-error message for unexpected errors", async function () {
    setMarkdownApiEnabled(true);
    setMarkdownApiRequireToken(false);
    const endpoint = createMarkdownQueryEndpoint({
      async searchByTitle() {
        return { candidates: [] };
      },
      async queryMarkdown() {
        throw new Error("database path C:\\Users\\secret\\profile.sqlite");
      },
    });

    const response = await endpoint.init(
      request("/mineru-for-zotero/markdown", {
        query: { libraryID: "1", key: "PDF1" },
      }),
    );
    const payload = JSON.parse(String(response[2])) as {
      error: string;
      message: string;
    };

    assert.equal(response[0], 500);
    assert.equal(payload.error, "internal-error");
    assert.equal(payload.message, "Unexpected internal error");
    assert.notInclude(String(response[2]), "profile.sqlite");
  });

  it("registers the expected endpoint paths", function () {
    assert.deepEqual(MARKDOWN_ENDPOINT_PATHS, [
      "/mineru-for-zotero/search",
      "/mineru-for-zotero/markdown",
      "/mineru-for-zotero/parse",
      "/mineru-for-zotero/tasks",
    ]);
  });

  it("returns task records through the tasks endpoint", async function () {
    setMarkdownApiEnabled(true);
    setMarkdownApiRequireToken(false);
    const endpoint = createMarkdownQueryEndpoint({
      ...fakeService(),
      async getTasks() {
        return { tasks: [{ id: "1", status: "running" }] };
      },
    });

    const response = await endpoint.init(request("/mineru-for-zotero/tasks"));

    assert.equal(response[0], 200);
    assert.include(String(response[2]), '"tasks":');
  });

  it("rejects non-POST parse triggers", async function () {
    setMarkdownApiEnabled(true);
    setMarkdownApiRequireToken(false);
    const endpoint = createMarkdownQueryEndpoint(fakeService());

    const response = await endpoint.init(
      request("/mineru-for-zotero/parse", {
        query: { libraryID: "1", key: "PDF1" },
      }),
    );

    assert.equal(response[0], 405);
    assert.include(String(response[2]), "invalid-request");
  });

  it("submits parse tasks through the parse endpoint", async function () {
    setMarkdownApiEnabled(true);
    setMarkdownApiRequireToken(false);
    let submitted: unknown;
    const endpoint = createMarkdownQueryEndpoint({
      ...fakeService(),
      async triggerParse(input) {
        submitted = input;
        return { status: "submitted", itemID: 1, key: "PDF1" };
      },
    });

    const response = await endpoint.init(
      request("/mineru-for-zotero/parse", {
        method: "POST",
        query: { libraryID: "1", key: "ABC1" },
      }),
    );

    assert.equal(response[0], 200);
    assert.include(String(response[2]), '"submitted"');
    const trigger = submitted as { libraryID: number; key: string };
    assert.equal(trigger.libraryID, 1);
    assert.equal(trigger.key, "ABC1");
  });
});

function fakeService() {
  return {
    async searchByTitle() {
      return { candidates: [] };
    },
    async queryMarkdown() {
      return { granularity: "full", content: "# Body" };
    },
    async triggerParse() {
      return { status: "submitted" };
    },
    async getTasks() {
      return { tasks: [] };
    },
  };
}

function runtimeRequest(
  pathname: string,
  overrides: Partial<{
    method: "GET" | "POST";
    searchParams: URLSearchParams;
    headers: Record<string, string>;
  }> = {},
) {
  return {
    method: overrides.method ?? "GET",
    pathname,
    pathParams: {},
    searchParams: overrides.searchParams ?? new URLSearchParams(),
    headers: overrides.headers ?? {},
    data: undefined,
  };
}

function request(
  pathname: string,
  overrides: Partial<{
    method: "GET" | "POST";
    query: Record<string, string>;
    headers: Record<string, string>;
  }> = {},
) {
  return {
    method: overrides.method ?? "GET",
    pathname,
    query: overrides.query ?? {},
    headers: overrides.headers ?? {},
    data: undefined,
  };
}
