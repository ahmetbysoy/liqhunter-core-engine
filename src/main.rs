use liqhunter_core_engine::engine::execution::ExecutionEngine;
use liqhunter_core_engine::engine::LiquidationEngine;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _analysis_engine = LiquidationEngine::production();
    let execution_engine = ExecutionEngine::from_env()?;

    println!(
        "LiqHunter core initialized. Execution mode: {:?}. Live order loop is not started.",
        execution_engine.mode()
    );
    Ok(())
}
