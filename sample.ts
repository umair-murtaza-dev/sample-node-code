@Injectable()
export class ChatbotService {
    constructor(
        private chatbotActionFactory: ChatbotActionFactory,
        private stepService: StepService,
        private whatsappService: WhatsappService,
        private authService: AuthService,
        private convoService: ConvoService,
        private variableResolverService: VariableResolverService,
        private companyService: CompanyService,
        private socketService: SocketService,
        private sessionService: ChatSessionService,
        private gptService: GptService,
        private queryService: UserqueryService,
    ) {}

    async reply(message: WhatsAppMessage<any>) {
        const company = await this.companyService.getCompanyByWAB(message.to);
        let user = await this.authService.getUserByWhatsapp(message.from, company);
        const convo = await this.convoService.getActiveConversation(company.id);
        const messageId = await this.stepService.getBranch(message.from, company.id);
        const convoMessage = await this.convoService.getMessage(messageId);
        let skipAction = convoMessage?.action && !user;
        
        if (skipAction) {
            await this.executeAction(convoMessage, message, company, user);
            user = await this.authService.getUserByWhatsapp(message.from, company);
        }
        
        const session = user ? await this.initiateSession(message, user, company) : undefined;
        if (user && session?.state === ChatState.Agent) return;

        if (!user || session?.state === ChatState.Chatbot) {
            let nextMessage = await this.convoService.getNextMessage(
                user, convoMessage, convo.id, message.message.body, !user
            );
            await this.processMessageFlow(
                nextMessage, convoMessage, message, user, company, convo, session, messageId, skipAction
            );
        } else {
            await this.handleAgentFlow(session, message);
        }
    }

    private async executeAction(convoMessage: any, message: any, company: any, user: any) {
        const action = this.chatbotActionFactory.getAction(convoMessage.action.name);
        await action.execute(message, null, company, user);
    }

    private async initiateSession(message: any, user: any, company: any) {
        const session = await this.createSession(UserType.User, user.id);
        await this.sessionService.addChatMessage(
            session.id, ChatMessageType.Customer, message.message.body
        );
        return session;
    }

    private async processMessageFlow(
        nextMessage: any, convoMessage: any, message: any, user: any,
        company: any, convo: any, session: any, messageId: any, skipAction: boolean
    ) {
        await this.sendPreMessage(nextMessage, messageId, convoMessage, message, user, company, convo, session?.id);
        
        if (nextMessage) {
            await this.handleNextMessage(
                nextMessage, convoMessage, message, user, company, session, skipAction
            );
        } else {
            await this.handleErrorMessage(convo, convoMessage, message, user, company, session);
        }
    }

    private async handleNextMessage(
        nextMessage: any, convoMessage: any, message: any, user: any,
        company: any, session: any, skipAction: boolean
    ) {
        let msgBody = nextMessage.message, error = null, errorShown = false;

        if (user && nextMessage) {
            if (convoMessage?.action && convoMessage.actionTime === ExecutionTime.onLeave && !skipAction) {
                error = await this.executeConvoAction(convoMessage, message, company, user, session, nextMessage);
            }
            if (nextMessage.action && nextMessage.actionTime === ExecutionTime.onLoad && !skipAction) {
                errorShown = await this.executeLoadAction(
                    nextMessage, message, user, company, convoMessage, session
                );
            }
        } else {
            msgBody = nextMessage.anonymousMessage;
        }

        if (nextMessage && !error?.stop) {
            await this.sendFinalMessage(nextMessage, message, user, company, msgBody, convoMessage, session, error, errorShown);
        }
    }

    private async handleErrorMessage(convo: any, convoMessage: any, message: any, user: any, company: any, session: any) {
        const errorMessage = await this.getErrorMessage(convo.id);
        await this.send(errorMessage.from, user, errorMessage.message, company, errorMessage.type, errorMessage.level, errorMessage.title, session?.id);
        await this.send(convoMessage.from, user, convoMessage.message, company, convoMessage.type, convoMessage.level, convoMessage.title, session?.id);
    }

    private async executeConvoAction(
        convoMessage: any, message: any, company: any, user: any, session: any, nextMessage: any
    ) {
        const action = this.chatbotActionFactory.getAction(convoMessage.action.name);
        return await action.execute(message, null, company, user, session, nextMessage);
    }

    private async executeLoadAction(
        nextMessage: any, message: any, user: any, company: any, convoMessage: any, session: any
    ) {
        const action = this.chatbotActionFactory.getAction(nextMessage.action.name);
        const error = await action.execute(message, null, company, user, session, nextMessage);

        if (error?.message) {
            await this.send(
                message.from, user, error.message, company, MessageType.text,
                convoMessage.level, convoMessage.title, session?.id
            );
            return true;
        }
        return false;
    }

    private async sendFinalMessage(
        nextMessage: any, message: any, user: any, company: any, msgBody: string,
        convoMessage: any, session: any, error: any, errorShown: boolean
    ) {
        await this.send(
            message.from, user, msgBody, company, nextMessage.type,
            nextMessage.level, nextMessage.title, session?.id, nextMessage.key
        );
    }

    private async handleAgentFlow(session: any, message: any) {
        if (session.agent) {
            await Promise.all([
                this.sessionService.addChatMessage(session.id, ChatMessageType.Agent, message.message.body),
                this.socketService.sendEventToAgent(SendEventToAgent, session.agent.id, { message: message.message.body }),
            ]);
        }
    }
}
