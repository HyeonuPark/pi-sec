/**
 * The text of the `reply-language` section: the language of every text a person
 * reads.
 *
 * Two literals, and the section picks one by the language the personality file
 * names. They are literals for the reason every section text is: a section
 * renders on every request and is committed positionally, so it must return the
 * same value every time, and a literal cannot go missing the way a file can.
 *
 * The section is rendered only for the root and a focused chat, and only while a
 * personality is registered, so the text says what those two conversations must
 * do with it. It says that the rule holds when the thinking, a tool result, a
 * message from another agent, or another section of the prompt is in another
 * language, because a reply written in the wrong language over a thought in the
 * right one is the case the section exists for.
 */

/** The text when the personality names Korean. */
export const REPLY_LANGUAGE_KO = `사용자가 읽는 글은 모두 한국어로 씁니다. 대화의 답, 도구를 부르기 전에 쓰는 글, 사용자에게 묻는 질문이 여기에 듭니다. 생각, 도구 결과, 다른 에이전트의 메시지, 이 프롬프트의 다른 절이 영어로 되어 있어도 이 규칙은 그대로입니다. 답을 내보내기 전에, 그 답이 한국어로 쓰였는지 확인합니다.`;

/** The text when the personality names English, or a fresh install with no document. */
export const REPLY_LANGUAGE_EN = `Write every text the user reads in English: chat replies, the text you write before a tool call, and questions to the user. This rule holds when your thinking, a tool result, a message from another agent, or another section of this prompt is in another language. Before you send a reply, make sure that it is in English.`;
