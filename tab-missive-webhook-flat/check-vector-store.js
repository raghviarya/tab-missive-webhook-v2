#!/usr/bin/env node

/**
 * Check if the vector store and files are properly set up
 */

const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function checkVectorStore() {
  try {
    console.log('🔍 Checking Vector Store...');
    console.log('Vector Store ID:', process.env.VECTOR_STORE_ID);
    console.log('Type:', typeof process.env.VECTOR_STORE_ID);
    console.log('String version:', String(process.env.VECTOR_STORE_ID));
    console.log('');
    
    // List files in the vector store
    const vectorStoreId = String(process.env.VECTOR_STORE_ID);
    console.log('Using vector store ID:', vectorStoreId);
    
    // Try a different approach - pass the ID directly as a parameter
    const files = await openai.vectorStores.files.list(vectorStoreId);
    
    console.log(`📁 Vector store has ${files.data.length} files:`);
    files.data.forEach((file, index) => {
      console.log(`  ${index + 1}. ${file.id} (status: ${file.status})`);
    });
    
    if (files.data.length === 0) {
      console.log('❌ No files found in vector store!');
      return;
    }
    
    // Check if files are ready
    const readyFiles = files.data.filter(f => f.status === 'completed');
    const processingFiles = files.data.filter(f => f.status === 'in_progress');
    
    console.log('');
    console.log(`✅ Ready files: ${readyFiles.length}`);
    console.log(`⏳ Processing files: ${processingFiles.length}`);
    
    if (processingFiles.length > 0) {
      console.log('⚠️  Some files are still processing. File search may not work until they are completed.');
    }
    
    if (readyFiles.length === 0) {
      console.log('❌ No files are ready for search!');
    } else {
      console.log('✅ Files are ready for search!');
    }
    
  } catch (error) {
    console.error('❌ Error checking vector store:', error.message);
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

checkVectorStore();
