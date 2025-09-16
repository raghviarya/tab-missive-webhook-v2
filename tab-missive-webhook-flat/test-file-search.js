#!/usr/bin/env node

/**
 * Test script to verify file search is working with your vector store
 */

const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function testFileSearch() {
  try {
    console.log('🧪 Testing File Search...');
    console.log('Vector Store ID:', process.env.VECTOR_STORE_ID);
    console.log('');
    
    const testQuery = "What are the canned responses for customer complaints?";
    
    console.log('Test Query:', testQuery);
    console.log('');
    
    const response = await openai.responses.create({
      model: "gpt-5",
      input: testQuery,
      tools: [{
        type: "file_search",
        vector_store_ids: [String(process.env.VECTOR_STORE_ID)]
      }],
      // Note: temperature not supported with GPT-5 in Responses API
    });
    
    console.log('📊 Response Output:');
    console.log(JSON.stringify(response, null, 2));
    
    // Check if file search was used
    const fileSearchOutput = response.output?.find(item => item.type === "file_search_call");
    if (fileSearchOutput) {
      console.log('');
      console.log('✅ File search was used!');
      console.log('File search details:', fileSearchOutput);
    } else {
      console.log('');
      console.log('❌ No file search was used');
    }
    
    // Get the message content
    const messageOutput = response.output?.find(item => item.type === "message");
    if (messageOutput) {
      console.log('');
      console.log('📝 AI Response:');
      console.log(messageOutput.content?.[0]?.text || 'No text content');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Check environment variables
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not set');
  process.exit(1);
}

if (!process.env.VECTOR_STORE_ID) {
  console.error('❌ VECTOR_STORE_ID not set');
  process.exit(1);
}

testFileSearch();
